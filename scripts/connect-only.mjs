import "dotenv/config";
import { selectProfile } from "../src/profiles.js";

selectProfile(process.env.CONNECT_PROFILE || "Prakash Kharwar");

const { config } = await import("../src/config.js");
const { openWarmupBrowser } = await import("../src/browser/session.js");
const { getWorkingPage } = await import("../src/scenario/linkedinFeed.js");
const { runConnectionBatch } = await import("../src/scenario/linkedinNetwork.js");
const { Optimizer } = await import("../src/optimizer/reviewer.js");
const { loadState, saveState } = await import("../src/sessionState.js");
const { beginRun, recoverInterruptedRun, weeklyBudget } = await import("../src/activity.js");
const { acquireLock } = await import("../src/lock.js");
const { pauseForAccount } = await import("../src/scenario/accountGuard.js");
const { flushNotifications, notify } = await import("../src/notifications/slack.js");
const { createLogger } = await import("../src/logger.js");

const log = createLogger("connect-only");
if (!["local", "cloud"].includes(config.browserMode)) throw new Error(`Unsupported browser mode: ${config.browserMode}`);
if (!config.connectionsEnabled) throw new Error("CONNECTIONS_ENABLED must be true.");

const release = acquireLock("browser");
let session;
let retainLock = false;
const started = Date.now();
try {
  const state = loadState();
  recoverInterruptedRun(state);
  // Pauses (including security challenges) are cleared only by `npm run resume -- --reviewed`.
  const optimizer = new Optimizer(state);
  const preflight = optimizer.preflight();
  if (!preflight.allow) {
    console.log(`Session blocked: ${preflight.reason}`);
    process.exitCode = 1;
    throw new Error(preflight.reason);
  }
  weeklyBudget(state);
  const plan = { ...preflight.plan, likeCap: 0, sessionMs: 60_000 };
  const run = beginRun(state, plan);
  notify("session_started", "Local connection-only test: no feed likes, at most one invitation", { run: run.id });
  await flushNotifications();
  session = await openWarmupBrowser();
  state.currentRun.cloudOwned = false;
  saveState(state);
  const page = await getWorkingPage(session.browser, { preferGrow: true });
  log.info("Running connection batch only.", { url: page.url() });
  const connections = await runConnectionBatch(page, state, {
    maxAttempts: 1,
    maxDurationMs: 12 * 60_000,
    gapRange: [8_000, 16_000],
  });
  log.info("Connection batch result.", { sent: connections.sent, attempted: connections.attempted, connections: connections.connections, reason: connections.reason });
  const snapshot = await page.evaluate(() => {
    const label = (el) => `${el.getAttribute("aria-label") || ""} | ${(el.innerText || "").replace(/\s+/g, " ").trim()}`.trim();
    return {
      url: location.href,
      snippet: (document.querySelector("main")?.innerText || "").slice(0, 1200),
      buttons: [...document.querySelectorAll("main button, main [role='button']")].slice(0, 40).map(label).filter(Boolean),
    };
  }).catch((error) => ({ error: error.message }));
  log.info("Post-connect page snapshot.", snapshot);
  const result = {
    likes: 0,
    postsSeen: 0,
    expanded: 0,
    seeNewPosts: 0,
    connections: connections.connections,
    connectionAttempts: connections.attempted,
    connectionNote: connections.reason,
    aborted: Boolean(connections.accountBlock),
    accountBlock: connections.accountBlock,
    reason: connections.accountBlock?.reason || connections.reason || "Connection-only test finished",
    durationMs: Date.now() - started,
    deniedReasons: {},
  };
  if (connections.accountBlock) {
    pauseForAccount(state, connections.accountBlock);
    saveState(state);
    notify("profile_paused", connections.accountBlock.reason);
  }
  optimizer.postflight(result);
  saveState(state);
  notify(result.aborted ? "session_failed" : "session_completed", result.reason, {
    run: run.id,
    connections: result.connections,
    connectionAttempts: result.connectionAttempts,
    connectionNote: result.connectionNote || "none",
  });
  console.log(JSON.stringify({
    aborted: result.aborted,
    connections: result.connections,
    attempted: result.connectionAttempts,
    sent: connections.sent,
    note: result.connectionNote,
    reason: result.reason,
    snapshotUrl: snapshot?.url || null,
  }, null, 2));
  if (result.aborted) process.exitCode = 1;
} catch (error) {
  retainLock ||= Boolean(error.retainBrowserLock);
  log.error("Connection-only test failed", { message: error.message });
  process.exitCode = 1;
  throw error;
} finally {
  try {
    if (session) {
      await session.browser.disconnect().catch(() => {});
      if (process.env.STOP_PROFILE_AFTER_SESSION === "false") {
        log.info("Leaving Orbita running for live inspection.");
      } else {
        await session.stop();
      }
    }
  } catch (error) {
    retainLock = true;
    log.error("Browser cleanup failed; browser lock retained", { message: error.message });
  } finally {
    if (!retainLock) release();
    await flushNotifications();
  }
}
