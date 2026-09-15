import { config } from "./config.js";
import { openWarmupBrowser } from "./browser/session.js";
import { createLogger, getWarningCounts } from "./logger.js";
import { Optimizer } from "./optimizer/reviewer.js";
import { getWorkingPage, runLinkedInFeed } from "./scenario/linkedinFeed.js";
import { runConnectionBatch } from "./scenario/linkedinNetwork.js";
import { pauseForAccount } from "./scenario/accountGuard.js";
import { loadState, saveState } from "./sessionState.js";
import { beginRun, recoverInterruptedRun, weeklyBudget } from "./activity.js";
import { claimWindow } from "./scheduler.js";
import { acquireLock } from "./lock.js";
import { flushNotifications, notify } from "./notifications/slack.js";
import { sleep } from "./util/random.js";
import { recordCancellation } from "./util/cancellation.js";

const log = createLogger("runner");

export async function runSession({ windowKey } = {}) {
  const release = acquireLock("browser");
  let session;
  let state;
  let optimizer;
  let timer;
  let finalized = false;
  let retainLock = false;
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { session?.browser.disconnect().catch(() => {}); }, { once: true });
  const stop = () => controller.abort(new Error("Session interrupted by operator"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    state = loadState();
    if (recoverInterruptedRun(state)) log.error("Recovered an interrupted session; previous action reservations remain consumed.");
    if (windowKey && !claimWindow(state, windowKey)) return { blocked: true, reason: "Window already consumed or missed" };
    optimizer = new Optimizer(state);
    const preflight = optimizer.preflight();
    if (!preflight.allow) {
      if (windowKey) state.windows[windowKey].status = "blocked";
      saveState(state);
      notify("session_blocked", preflight.reason);
      return { blocked: true, reason: preflight.reason };
    }
    if (!preflight.plan.testRun && config.connectionsEnabled) weeklyBudget(state);
    const run = beginRun(state, preflight.plan);
    const limitAt = Date.now() + preflight.plan.sessionMs + 7 * 60_000;
    let lastHeartbeat = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      if (now - lastHeartbeat > 60_000) controller.abort(new Error("Mac slept or execution stalled; ending this session without catch-up actions"));
      if (now >= limitAt) controller.abort(new Error("Session exceeded its execution deadline"));
      lastHeartbeat = now;
    }, 1000);
    notify("session_started", preflight.plan.testRun ? "Browse-only test started" : preflight.plan.connectionTrial ? "Connection trial started: zero likes, at most one invitation after browsing" : "Warm-up session started", { run: run.id });
    await flushNotifications();
    controller.signal.throwIfAborted();
    session = await openWarmupBrowser();
    controller.signal.throwIfAborted();
    // Attach to a tab before the long settle — waiting first lets LinkedIn paint
    // wedge Orbita CDP on some local profiles (Network.enable hangs).
    const page = await getWorkingPage(session.browser);
    await sleep(Math.min(preflight.plan.settleMs, 4_000));
    controller.signal.throwIfAborted();
    const result = recordCancellation(await runLinkedInFeed(page, preflight.plan, optimizer, { signal: controller.signal }), controller.signal);
    if (!result.aborted && !preflight.plan.testRun) {
      controller.signal.throwIfAborted();
      const connections = await runConnectionBatch(page, state, { signal: controller.signal, maxAttempts: preflight.plan.connectionTrial ? 1 : undefined });
      result.connections = connections.connections;
      result.connectionAttempts = connections.attempted;
      result.connectionNote = connections.reason;
      if (connections.accountBlock) {
        result.aborted = true;
        result.accountBlock = connections.accountBlock;
        result.reason = connections.accountBlock.reason;
      }
    }
    recordCancellation(result, controller.signal);
    if (result.accountBlock) {
      pauseForAccount(state, result.accountBlock);
      saveState(state);
      notify("profile_paused", result.accountBlock.reason, { action: "Open this profile manually, resolve the issue, then run resume --reviewed" });
    }
    result.durationMs = Date.now() - new Date(run.at).getTime();
    optimizer.postflight(result);
    if (windowKey) state.windows[windowKey].status = result.aborted ? "failed" : "completed";
    saveState(state);
    finalized = true;
    notify(result.aborted ? "session_failed" : "session_completed", result.reason || "Session finished", {
      run: run.id, posts: result.postsSeen, expanded: result.expanded, likes: result.likes,
      connections: result.connections || 0, connectionAttempts: result.connectionAttempts || 0,
      connectionNote: result.connectionNote || "none", minutes: (result.durationMs / 60_000).toFixed(1),
      warnings: JSON.stringify(getWarningCounts()),
    });
    return { blocked: false, result };
  } catch (error) {
    retainLock ||= Boolean(error.retainBrowserLock);
    if (state?.currentRun && optimizer && !finalized) {
      const run = state.currentRun;
      if (state.actions.some((action) => action.runId === run.id && action.kind === "connect" && action.status !== "confirmed")) {
        pauseForAccount(state, { kind: "uncertain_connection", reason: "Interrupted connection attempt requires invitation review" });
      }
      const confirmed = state.actions.filter((a) => a.runId === run.id && a.status === "confirmed");
      optimizer.postflight({ likes: confirmed.filter((a) => a.kind === "like").length, connections: confirmed.filter((a) => a.kind === "connect").length, postsSeen: 0, expanded: 0, durationMs: Date.now() - new Date(run.at).getTime(), aborted: true, checkpoint: false, reason: error.message, deniedReasons: {} });
      if (windowKey) state.windows[windowKey].status = "failed";
      saveState(state);
    }
    log.error("Session failed", { message: error.message });
    throw error;
  } finally {
    clearInterval(timer);
    try {
      if (session) {
        await session.browser.disconnect().catch(() => {});
        await session.stop();
      }
    } catch (error) {
      retainLock = true;
      log.error("Browser cleanup failed; browser lock retained", { message: error.message });
      throw error;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (!retainLock) release();
      await flushNotifications();
    }
  }
}
