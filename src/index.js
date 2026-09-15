import "dotenv/config";
import { pathToFileURL } from "node:url";
import { selectProfile, loadProfiles } from "./profiles.js";
import { notify, flushNotifications, redact } from "./notifications/slack.js";

function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
  return args[at + 1];
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || "status";
  if (command === "notify:test") {
    notify("notification_test", "Slack reporting is connected. This message does not indicate a LinkedIn session or connection request.");
    const result = await flushNotifications();
    if (!result.sent || result.pending || result.unavailable) throw new Error("Slack test was not fully delivered; notification remains queued.");
    return;
  }
  if (command === "notify:flush") { await flushNotifications(); return; }
  if (command === "schedule") {
    const { runService } = await import("./service.js");
    await runService();
    return;
  }
  if (command === "status") {
    const { loadState } = await import("./sessionState.js");
    for (const profile of loadProfiles()) {
      const state = loadState(profile);
      console.log(JSON.stringify({ ...profile, enrolledAt: state.enrolledAt || "not started", pause: state.pause, currentRun: state.currentRun, lastSession: state.lastSession, weekly: state.weekly, scheduled: Object.entries(state.windows).filter(([, v]) => v.status === "scheduled") }, null, 2));
    }
    return;
  }
  if (command === "unlock") {
    const { unlockStoppedProcess } = await import("./lock.js");
    const name = option(args, "--lock");
    if (!["browser", "service"].includes(name)) throw new Error("Use unlock --lock browser or unlock --lock service.");
    unlockStoppedProcess(name);
    console.log(`Released stopped process's ${name} lock.`);
    return;
  }
  if (!["once", "resolve", "review", "pause", "resume", "audit:network"].includes(command)) throw new Error("Commands: status, schedule, once, resolve, review, pause, resume, audit:network, notify:test, notify:flush, unlock");
  const profile = selectProfile(option(args, "--profile"));
  if (command === "resolve") {
    const { resolveWarmupProfile } = await import("./browser/session.js");
    console.log(JSON.stringify(await resolveWarmupProfile(), null, 2));
  } else if (command === "review") {
    const { config, sampleSessionPlan } = await import("./config.js");
    console.log(JSON.stringify({ profile, defaults: { sessionMinutes: config.sessionMinutes, workHoursIST: "09:00–17:00", connectionWeeklyRanges: config.connectionWeeklyRanges, reset: config.connectionWeekReset, connectionBatchRange: config.connectionBatchRange, connectionsEnabled: config.connectionsEnabled }, samplePlan: sampleSessionPlan() }, null, 2));
  } else if (command === "pause" || command === "resume") {
    const { acquireLock } = await import("./lock.js");
    const { loadState, saveState } = await import("./sessionState.js");
    const release = acquireLock("browser");
    try {
      const state = loadState();
      if (command === "pause") state.pause ||= { kind: "operator", reason: option(args, "--reason") || "Paused by operator", at: new Date().toISOString() };
      else {
        if (!args.includes("--reviewed")) throw new Error("After manually reviewing the account, use resume --reviewed.");
        if (state.pause?.cooldownUntil && Date.now() < new Date(state.pause.cooldownUntil).getTime()) throw new Error(`Challenge cooldown lasts until ${state.pause.cooldownUntil}.`);
        state.pause = null;
        state.reviewedAt = new Date().toISOString();
      }
      saveState(state);
      notify(command === "pause" ? "profile_paused" : "profile_resumed", command === "pause" ? state.pause.reason : "Operator confirmed manual account review.");
    } finally { release(); }
  } else if (command === "audit:network") {
    const { auditNetwork } = await import("./networkAudit.js");
    await auditNetwork();
  } else {
    if (!profile.enabled) throw new Error("This profile is disabled in the registry.");
    const { runSession } = await import("./runner.js");
    const result = await runSession({ windowKey: option(args, "--window") });
    if (result.blocked) console.log(`Session blocked: ${result.reason}`);
    if (result.result?.aborted) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(redact(error.message));
    try { notify("command_failed", error.message); } catch { /* filesystem failure already reported */ }
    process.exitCode = 1;
  }).finally(async () => {
    await flushNotifications();
    // Owned browser work and notification delivery have completed.
  });
}
