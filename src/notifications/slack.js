import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../util/files.js";
import { dataDir } from "../util/paths.js";

const defaultDirectory = join(dataDir, "notifications");

export function redact(value) {
  let text = String(value).replace(/https:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/gi, "[Slack webhook]");
  for (const key of ["SLACK_WEBHOOK_URL", "GL_API_TOKEN", "GOLOGIN_API_TOKEN", "GL_TOKEN"]) {
    if (process.env[key]) text = text.split(process.env[key]).join("[redacted]");
  }
  return text;
}

export class SlackNotifier {
  constructor({ directory = defaultDirectory, webhook = () => process.env.SLACK_WEBHOOK_URL, fetchImpl = fetch, now = Date.now } = {}) {
    this.directory = directory;
    this.webhook = webhook;
    this.fetch = fetchImpl;
    this.now = now;
    this.flushing = null;
  }

  enqueue({ type, profile, message, details = {} }) {
    // Read credentials only at delivery time; never persist them in the outbox.
    const id = randomUUID();
    const label = profile?.name || profile?.profileName || "service";
    const profileId = profile?.profile_id || profile?.profileId;
    const lines = [
      `LinkedIn warm-up | ${type}`,
      `Profile: ${label}${profileId ? ` (${profileId})` : ""}`,
      message,
      ...Object.entries(details).map(([key, value]) => `${key}: ${value}`),
      `Time: ${new Date(this.now()).toISOString()}`,
      `Event: ${id}`,
    ];
    writeJsonAtomic(join(this.directory, `${this.now()}-${id}.json`), {
      id, text: redact(lines.join("\n")).slice(0, 6000), attempts: 0, nextAttemptAt: 0,
    });
    return id;
  }

  flush() {
    if (!this.flushing) this.flushing = this.deliver().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async deliver() {
    if (!existsSync(this.directory)) return { sent: 0, pending: 0 };
    const files = readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort();
    const webhook = this.webhook();
    if (!webhook) return { sent: 0, pending: files.length, reason: "SLACK_WEBHOOK_URL is missing" };
    const url = new URL(webhook);
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || !url.pathname.startsWith("/services/")) {
      throw new Error("Invalid SLACK_WEBHOOK_URL; expected a Slack incoming webhook.");
    }
    let sent = 0;
    let attempted = 0;
    let lastError;
    // A bounded batch avoids delaying browser cleanup when Slack is unavailable.
    for (const name of files) {
      if (attempted >= 10) break;
      const path = join(this.directory, name);
      let event;
      try { event = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw new Error("Unreadable Slack outbox event", { cause: error }); }
      if (event.nextAttemptAt > this.now()) continue;
      attempted += 1;
      let retryMs;
      try {
        const response = await this.fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: event.text, mrkdwn: false, unfurl_links: false, unfurl_media: false }),
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok || (await response.text()).trim() !== "ok") {
          const retrySeconds = Number(response.headers?.get("retry-after"));
          if (Number.isFinite(retrySeconds) && retrySeconds > 0) retryMs = retrySeconds * 1000;
          throw new Error(`Slack returned HTTP ${response.status}`);
        }
        try { unlinkSync(path); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        sent += 1;
      } catch (error) {
        // Timeout may follow successful delivery. Retrying is at-least-once; event ID identifies duplicates.
        event.attempts += 1;
        lastError = redact(error.cause?.code || error.message);
        event.lastError = lastError;
        event.nextAttemptAt = this.now() + Math.max(retryMs || 0, Math.min(3600_000, 30_000 * 2 ** Math.min(event.attempts - 1, 7)));
        writeJsonAtomic(path, event);
        break;
      }
    }
    return { sent, pending: readdirSync(this.directory).filter((name) => name.endsWith(".json")).length, lastError };
  }
}

export const slack = new SlackNotifier();

export function notify(type, message, details = {}, profile) {
  return slack.enqueue({
    type,
    profile: profile || { name: process.env.GL_PROFILE_NAME || process.env.GOLOGIN_PROFILE_NAME, profile_id: process.env.GL_PROFILE_ID || process.env.GOLOGIN_PROFILE_ID },
    message,
    details,
  });
}

export async function flushNotifications() {
  try {
    const result = await slack.flush();
    if (result.pending) console.warn(`Slack: ${result.pending} notification(s) queued for retry.${result.lastError ? ` ${result.lastError}` : ""}`);
    return result;
  } catch (error) {
    console.error(`Slack delivery unavailable: ${redact(error.message)}`);
    return { sent: 0, unavailable: true };
  }
}
