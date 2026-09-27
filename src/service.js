import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadProfiles } from "./profiles.js";
import { loadState, saveState } from "./sessionState.js";
import { nextRunAt } from "./scheduler.js";
import { acquireLock } from "./lock.js";
import { notify, flushNotifications, redact } from "./notifications/slack.js";
import { createLogger } from "./logger.js";
import { sleep } from "./util/random.js";
import { config } from "./config.js";
import { stopCloudProfile } from "./gologin/cloud.js";

const log = createLogger("service");
const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));

function reportProfileFailure(profile, error) {
  console.error(redact(`Profile scheduling blocked (${profile.profileName}): ${error.message}`));
  notify("profile_scheduling_failed", error.message, {}, profile);
}

export function planProfiles(profiles, failures, { read = loadState, write = saveState, next = nextRunAt, report = reportProfileFailure } = {}) {
  const jobs = [];
  for (const profile of profiles.filter((p) => p.enabled)) {
    try {
      const state = read(profile);
      const previous = JSON.stringify(state);
      const upcoming = next(state);
      if (JSON.stringify(state) !== previous) write(state, profile);
      if (upcoming) jobs.push({ profile, ...upcoming });
      failures.delete(profile.profileId);
    } catch (error) {
      // Fail closed for this profile without stopping the others or flooding Slack.
      if (failures.get(profile.profileId) !== error.message) report(profile, error);
      failures.set(profile.profileId, error.message);
    }
  }
  return jobs.sort((a, b) => a.at - b.at);
}

// Scheduled workers never inherit a verification request and are marked so config ignores
// one even if it reappears.
export function workerEnv(env = process.env) {
  const { VERIFY_WARMUP: _ignored, ...rest } = env;
  return { ...rest, TEST_RUN: "false", WARMUP_SCHEDULED_WORKER: "1" };
}

export function workerArgs(entry, profileId, windowKey) {
  return [entry, "once", "--profile", profileId, "--window", windowKey];
}

export async function runService() {
  if (process.env.VERIFY_WARMUP || process.argv.includes("--verify-warmup")) {
    log.warn("VERIFY_WARMUP is ignored by the scheduler; scheduled sessions always use the production plan. Use `npm run once` for a verification session.");
  }
  const release = acquireLock("service");
  let stopping = false;
  let child;
  const profileFailures = new Map();
  const stop = () => { stopping = true; child?.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  notify("service_started", "Local scheduler started. Profiles run sequentially; missed windows are skipped.", {}, { name: "service" });
  let lastFlush = 0;
  try {
    while (!stopping) {
      if (Date.now() - lastFlush >= 60_000) { await flushNotifications(); lastFlush = Date.now(); }
      let jobs = [];
      let releaseBrowser;
      try {
        releaseBrowser = acquireLock("browser");
        jobs = planProfiles(loadProfiles(), profileFailures);
      } catch (error) {
        if (!/holds the browser lock/.test(error.message)) throw error;
      } finally { releaseBrowser?.(); }
      jobs.sort((a, b) => a.at - b.at);
      const due = jobs.find((job) => job.at.getTime() <= Date.now());
      if (due && !stopping) {
        const outcome = await new Promise((resolve, reject) => {
          child = spawn(process.execPath, workerArgs(entrypoint, due.profile.profileId, due.key), {
            stdio: "inherit",
            env: workerEnv(),
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            if (code !== 0 && !stopping) log.error("Profile worker exited unsuccessfully", { profile: due.profile.profileName, code, signal });
            resolve({ code, signal });
          });
        });
        child = null;
        if ((outcome.code !== 0 || outcome.signal) && config.browserMode === "cloud" && config.stopProfileAfterSession && config.gologinToken) {
          try {
            await stopCloudProfile(due.profile.profileId, { token: config.gologinToken });
            log.info("Stopped cloud profile after an abnormal worker exit", { profile: due.profile.profileName, signal: outcome.signal });
          } catch (error) {
            log.error("Could not stop cloud profile after worker exit", { profile: due.profile.profileName, message: error.message });
            notify("profile_cleanup_failed", error.message, {}, due.profile);
          }
        }
      }
      if (!stopping) await sleep(5000);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    release();
    notify("service_stopped", "Local scheduler stopped.", {}, { name: "service" });
    await flushNotifications();
  }
}
