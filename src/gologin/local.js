// Contract: GoLogin's Local REST API, served by the desktop app on this Mac.
// https://www.postman.com/gologinapp/gologin/folder/dvcdgnu/local-rest-api
import { createLogger } from "../logger.js";
import { infrastructureError } from "../util/failures.js";
import { initialTabUrl, waitForInitialTab } from "../browser/page.js";

const log = createLogger("gologin");
export const STARTUP_FEED_ATTEMPTS = 3;
export const STARTUP_FEED_WAIT_MS = 10_000;
export const STARTUP_FEED_URL = "https://www.linkedin.com/feed/";
export const DEBUGGER_DISCOVERY_MS = 90_000;

function annotate(error, message, retainBrowserLock) {
  const wrapped = new Error(message, { cause: error });
  wrapped.retainBrowserLock = retainBrowserLock;
  return wrapped;
}

export function responseSnippet(text, token) {
  let snippet = String(text ?? "").slice(0, 2000).replace(/\s+/g, " ").trim();
  if (token) snippet = snippet.split(token).join("[redacted]");
  snippet = snippet
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}]+/gi, "$1[redacted]")
    .replace(/\bbearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(/((?:access_|api_|auth_|refresh_)?token["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1[redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-+/]{32,}={0,2}/g, "[redacted]");
  return snippet.slice(0, 200);
}

// GoLogin profiles open these fingerprint checkers as start tabs. They are never the working tab.
const FINGERPRINT_CHECK_HOSTS = ["iphey.com", "pixelscan.net", "browserscan.net", "whoer.net", "browserleaks.com", "abrahamjuliot.github.io", "creepjs.org"];

export function isFingerprintCheckHost(host) {
  const value = String(host || "").toLowerCase();
  return FINGERPRINT_CHECK_HOSTS.some((known) => value === known || value.endsWith(`.${known}`));
}

export function startupPageKind(href) {
  const raw = String(href || "");
  if (!raw || raw === ":" || /^about:blank$/i.test(raw)) return "empty";
  if (/^chrome-error:/i.test(raw)) return "proxy-error";
  let parsed;
  try { parsed = new URL(raw); }
  catch { return "empty"; }
  const host = parsed.hostname.toLowerCase();
  if (host === "mail.google.com" || host === "gmail.com" || host === "bing.com" || host.endsWith(".bing.com")) return "web-start";
  if (isFingerprintCheckHost(host)) return "web-start";
  if (host === "www.linkedin.com" || host === "linkedin.com") {
    if (/checkpoint|challenge|captcha|authwall|\/login|\/signup|\/uas\//i.test(`${parsed.pathname}${parsed.search}`)) return "account";
    return "linkedin";
  }
  return "other";
}

function pickStartupTarget(targets) {
  const list = (Array.isArray(targets) ? targets : []).filter(Boolean);
  const kindOf = (target) => startupPageKind(initialTabUrl(target));
  return list.find((target) => kindOf(target) === "linkedin" || kindOf(target) === "account")
    || list.find((target) => kindOf(target) === "proxy-error" || kindOf(target) === "web-start")
    || list.find((target) => kindOf(target) !== "empty")
    || null;
}

export async function settleStartupNavigation({
  listTargets,
  navigate,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = STARTUP_FEED_ATTEMPTS,
  waitMs = STARTUP_FEED_WAIT_MS,
  feedUrl = STARTUP_FEED_URL,
} = {}) {
  let lastUrl = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const target = pickStartupTarget(await listTargets());
    const url = initialTabUrl(target);
    const kind = startupPageKind(url);
    if (kind === "linkedin" || kind === "account" || kind === "other") return { kind, url };
    lastUrl = url;
    if (kind === "proxy-error" || kind === "web-start") {
      try { await navigate(target, feedUrl); }
      catch (error) { lastUrl = `${url} (${error.message})`; }
    }
    await pause(waitMs);
  }
  const target = pickStartupTarget(await listTargets());
  const url = initialTabUrl(target);
  const kind = startupPageKind(url);
  if (kind === "linkedin" || kind === "account" || kind === "other") return { kind, url };
  throw infrastructureError(`Proxy or browser could not open ${feedUrl} after ${attempts} attempts (last page ${url || lastUrl || "unknown"}). Infrastructure failure; the LinkedIn account was not paused.`);
}

function assertLoopbackSocket(wsUrl) {
  const url = new URL(wsUrl);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Refusing to drive a non-local browser target.");
  }
}

function cdpNavigate(wsUrl, feedUrl, timeoutMs = 15_000) {
  assertLoopbackSocket(wsUrl);
  if (feedUrl !== STARTUP_FEED_URL) throw new Error("Refusing to open a non-feed URL during startup.");
  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(result || {});
    };
    const timer = setTimeout(() => finish(new Error("CDP navigate timed out")), timeoutMs);
    try { ws = new WebSocket(wsUrl); }
    catch (error) { finish(error); return; }
    let nextId = 0;
    const pending = new Map();
    const send = (method, params) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };
    ws.addEventListener("open", () => {
      send("Page.enable", {})
        .then(() => send("Page.navigate", { url: feedUrl }))
        .then((result) => finish(result?.errorText ? new Error(result.errorText) : null, result))
        .catch((error) => finish(error));
    });
    ws.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.error) waiter.rej(new Error(data.error.message || "CDP navigate failed"));
      else waiter.res(data.result || {});
    });
    ws.addEventListener("error", () => finish(new Error("CDP navigate socket failed")));
    ws.addEventListener("close", () => finish(new Error("CDP navigate socket closed")));
  });
}

export class LocalProfileLauncher {
  constructor({ token, fetchImpl = fetch, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), listTargets = null, navigateTarget = null, listProcesses = null } = {}) {
    this.token = token;
    this.listProcesses = listProcesses;
    this.fetch = fetchImpl;
    this.profileId = null;
    this.wsUrl = null;
    this.now = now;
    this.pause = pause;
    this.listTargets = listTargets;
    this.navigateTarget = navigateTarget;
  }

  async request(operation, body, timeoutMs) {
    const response = await this.fetch(`http://127.0.0.1:36912/browser/${operation}-profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    // A 4xx is GoLogin answering "no" (for example a failed proxy check): it did not start a
    // browser. A 5xx can come from a launch that failed halfway, so it stays uncertain.
    const refused = (message) => Object.assign(new Error(message), { refused: response.status >= 400 && response.status < 500 });
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch {
      throw refused(`GoLogin local ${operation} returned an invalid response (HTTP ${response.status}): ${JSON.stringify(responseSnippet(text, this.token))}.`);
    }
    if (!response.ok || json.status === "error" || json.status === "failed") {
      throw refused(`GoLogin local ${operation} failed (HTTP ${response.status}): ${json.message || json.error || "request rejected"}`);
    }
    return json;
  }

  async processListing() {
    try {
      if (typeof this.listProcesses === "function") return String(await this.listProcesses());
      const { execFileSync } = await import("node:child_process");
      return execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    } catch {
      return "";
    }
  }

  async discoverDebuggerUrl(timeoutMs = DEBUGGER_DISCOVERY_MS) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const listing = await this.processListing();
      for (const line of listing.split("\n")) {
        if (this.profileId && !line.includes(`GoLogin/profiles/${this.profileId}`)) continue;
        if (!/Orbita-Browser\.app\/Contents\/MacOS\/Orbita/.test(line)) continue;
        const match = line.match(/--remote-debugging-port=(\d+)/);
        if (!match) continue;
        try {
          const response = await this.fetch(`http://127.0.0.1:${match[1]}/json/version`, { redirect: "error", signal: AbortSignal.timeout(1500) });
          if (!response.ok) continue;
          const json = await response.json();
          const wsUrl = json.webSocketDebuggerUrl;
          if (!wsUrl) continue;
          const url = new URL(wsUrl);
          if (url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return wsUrl;
        } catch { /* not this port */ }
      }
      await this.pause(1500);
    }
    return null;
  }

  async readPageTargets(wsUrl) {
    if (typeof this.listTargets === "function") return this.listTargets(wsUrl);
    try {
      const endpoint = new URL(wsUrl);
      endpoint.protocol = "http:";
      endpoint.pathname = "/json/list";
      endpoint.search = "";
      endpoint.hash = "";
      const response = await this.fetch(endpoint.toString(), { redirect: "error", signal: AbortSignal.timeout(2_500) });
      if (!response?.ok || typeof response.json !== "function") return null;
      const json = await response.json();
      if (!Array.isArray(json)) return null;
      return json
        .filter((target) => !target.type || target.type === "page")
        .map((target) => ({
          id: target.id,
          url: target.url || "",
          webSocketDebuggerUrl: target.webSocketDebuggerUrl || "",
        }));
    } catch {
      return null;
    }
  }

  async navigateFeed(target, feedUrl = STARTUP_FEED_URL) {
    if (feedUrl !== STARTUP_FEED_URL) throw new Error("Refusing to open a non-feed URL during startup.");
    const kind = startupPageKind(initialTabUrl(target));
    if (kind === "account" || kind === "linkedin") return;
    if (typeof this.navigateTarget === "function") return this.navigateTarget(target, feedUrl);
    const socket = target?.webSocketDebuggerUrl;
    if (!socket) throw new Error("Startup tab has no local debugger socket.");
    return cdpNavigate(socket, feedUrl);
  }

  async prepareStartupNavigation(wsUrl) {
    const ready = await waitForInitialTab(() => this.readPageTargets(wsUrl), {
      pause: async (ms) => {
        log.info("Startup tab is not open yet. Waiting before checking again.", { waitMs: ms });
        await this.pause(ms);
      },
    });
    if (ready == null) return;
    await settleStartupNavigation({
      listTargets: async () => (await this.readPageTargets(wsUrl)) || [],
      navigate: async (target, feedUrl) => {
        log.info("Startup tab is Gmail, Bing, a fingerprint checker, or a Chrome network error. Retrying the LinkedIn feed.", { from: initialTabUrl(target) });
        await this.navigateFeed(target, feedUrl);
      },
      pause: this.pause,
    });
  }

  async start(profileId) {
    this.profileId = profileId;
    this.launched = false;
    try {
      const started = await this.request("start", {
        profileId,
        sync: true,
        // Best-effort; desktop API may ignore unknown fields. Orbita binary is also wrapped.
        args: [
          "--disable-gpu",
          "--disable-gpu-compositing",
          "--disable-dev-shm-usage",
          "--disable-features=Vulkan",
          "--use-gl=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      }, 240_000);
      this.launched = true;
      log.info("GoLogin accepted the start request.", { profile_id: profileId });
      // GoLogin often returns success with an empty wsUrl while Orbita is still
      // binding the debugger. An empty string must not be passed to URL().
      if (started.wsUrl === "") {
        const discovered = await this.discoverDebuggerUrl(DEBUGGER_DISCOVERY_MS);
        if (!discovered) {
          throw infrastructureError(`GoLogin started without a local debugger endpoint after ${Math.round(DEBUGGER_DISCOVERY_MS / 1000)}s. Stopping this profile; the LinkedIn account was not paused.`);
        }
        this.wsUrl = discovered;
        await this.prepareStartupNavigation(discovered);
        return discovered;
      }
      const url = new URL(started.wsUrl);
      if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || !url.pathname.startsWith("/devtools/browser/")) {
        throw new Error("GoLogin returned a non-local or invalid browser endpoint.");
      }
      this.wsUrl = started.wsUrl;
      await this.prepareStartupNavigation(started.wsUrl);
      return started.wsUrl;
    } catch (error) {
      if (this.launched) error.browserLaunched = true;
      if (error.refused && !this.launched) {
        this.profileId = null;
        const wrapped = new Error(`GoLogin refused to start this profile: ${error.message} No browser was started, so the browser lock is safe to release.`, { cause: error });
        wrapped.failureKind = "infra";
        wrapped.retainBrowserLock = false;
        throw wrapped;
      }
      if (error.failureKind === "infra") {
        try { await this.stop(); }
        catch (stopError) {
          stopError.failureKind = "infra";
          if (error.message && !String(stopError.message).includes(error.message)) stopError.message = `${error.message} ${stopError.message}`;
          throw stopError;
        }
        throw error;
      }
      // A timeout/rejected response cannot establish whether the app started a browser.
      // Never retry Start or stop a potentially pre-existing manual session.
      const unavailable = error.cause?.code === "ECONNREFUSED";
      this.profileId = null;
      const wrapped = annotate(
        error,
        unavailable
          ? "GoLogin's local API is unavailable. Open GoLogin.app and retry."
          : `${error.message} Inspect this profile in GoLogin before releasing the browser lock.`,
        !unavailable,
      );
      // A refused socket means the desktop app never received Start.
      if (unavailable) wrapped.networkOutage = true;
      throw wrapped;
    }
  }

  async orbitaRunning() {
    const listing = await this.processListing();
    return listing.split("\n").some((line) => line.includes(`GoLogin/profiles/${this.profileId}`) && /Orbita/.test(line));
  }

  // Without a debugger endpoint there is nothing to poll, so shutdown is confirmed from the
  // process list instead.
  async waitForOrbitaExit(timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (await this.orbitaRunning()) {
      if (this.now() >= deadline) return false;
      await this.pause(1_000);
    }
    return true;
  }

  async stop() {
    if (!this.profileId) return;
    try {
      await this.request("stop", { profileId: this.profileId }, 60_000);
      // The app responds 204 before killProfile finishes. Do not release our
      // browser lock until the owned debugging endpoint is no longer running.
      if (this.wsUrl) {
        const endpoint = new URL(this.wsUrl);
        endpoint.protocol = "http:";
        endpoint.pathname = "/json/version";
        const deadline = this.now() + 30_000;
        let closed = false;
        while (this.now() < deadline) {
          try {
            const response = await this.fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(2000) });
            if (response.ok) {
              const data = await response.json();
              if (data.webSocketDebuggerUrl && data.webSocketDebuggerUrl !== this.wsUrl) { closed = true; break; }
            }
          } catch (error) {
            if (error.cause?.code === "ECONNREFUSED") { closed = true; break; }
          }
          await this.pause(500);
        }
        if (!closed) throw new Error("GoLogin browser endpoint remained open after Stop.");
      } else if (!(await this.waitForOrbitaExit(30_000))) {
        throw new Error("Orbita for this profile was still running 30s after Stop.");
      }
      this.profileId = null;
      this.wsUrl = null;
    } catch (error) {
      throw annotate(
        error,
        `${error.message} Browser shutdown is unconfirmed; close it in GoLogin before releasing the browser lock.`,
        true,
      );
    }
  }
}
