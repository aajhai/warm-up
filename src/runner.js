import { config } from "./config.js";
import { openWarmupBrowser } from "./browser/session.js";
import { createLogger, getWarningCounts } from "./logger.js";
import { Optimizer } from "./optimizer/reviewer.js";
import { getWorkingPage, runLinkedInFeed } from "./scenario/linkedinFeed.js";
import { runConnectionBatch } from "./scenario/linkedinNetwork.js";
import { runSearch } from "./scenario/linkedinProfile.js";
import { pauseForAccount } from "./scenario/accountGuard.js";
import { loadState, saveState } from "./sessionState.js";
import { beginRun, hasUncertainConnect, recoverInterruptedRun, weeklyBudget } from "./activity.js";
import { claimWindow } from "./scheduler.js";
import { acquireLock } from "./lock.js";
import { flushNotifications, notify } from "./notifications/slack.js";
import { randomInt, sleep } from "./util/random.js";
import { pagePointer } from "./human/trackpad.js";
import { PRESS_TIMEOUT_MS } from "./human/press.js";
import { recordCancellation } from "./util/cancellation.js";
import { failureKind, isInfrastructureFailure } from "./util/failures.js";
import { stopCloudProfile } from "./gologin/cloud.js";

const log = createLogger("runner");

function blankResult() {
  return { likes: 0, postsSeen: 0, expanded: 0, seeNewPosts: 0, durationMs: 0, aborted: false, checkpoint: false, deniedReasons: {} };
}

const delivered = (sent) => (sent || []).filter((item) => !item.notSent).length;

// How long to stay on LinkedIn after the session's last invite press. Zero when no invite
// went out; otherwise a fresh 60-180s draw, less whatever time has already passed.
export function postInviteDwellMs({ sent = [], lastInviteAt = null, now = Date.now(), rng = Math.random } = {}) {
  if (!delivered(sent) || !lastInviteAt) return 0;
  const { min, max } = config.postInviteDwellMs;
  return Math.max(0, Math.round(min + rng() * (max - min)) - Math.max(0, now - lastInviteAt));
}

function wheelOnPage(page) {
  return async (deltaY) => {
    const pointer = pagePointer(page);
    if (!pointer.x && !pointer.y) { pointer.x = randomInt(420, 640); pointer.y = randomInt(300, 480); }
    try {
      await pointer.dispatch({ type: "mouseWheel", x: pointer.x, y: pointer.y, deltaX: 0, deltaY, modifiers: 0, pointerType: "mouse" }, PRESS_TIMEOUT_MS);
    } catch { /* sitting still is also fine */ }
  };
}

// Sits on the current LinkedIn page with an occasional small scroll, beating the stall
// watchdog every second. Time is counted from the pauses so a cancelled session stops at
// the next second.
export async function postInviteDwell(page, ms, { signal, onHeartbeat = () => {}, pause = sleep, rng = Math.random, scroll = wheelOnPage(page) } = {}) {
  log.info("Staying on LinkedIn after the last invite before closing.", { seconds: Math.round(ms / 1000) });
  let waited = 0;
  let nextScrollAt = randomInt(8_000, 25_000);
  while (waited < ms) {
    if (signal?.aborted) return waited;
    onHeartbeat();
    if (waited >= nextScrollAt) {
      if (rng() < 0.6) await scroll(rng() < 0.15 ? -randomInt(80, 200) : randomInt(120, 320));
      onHeartbeat();
      nextScrollAt = waited + randomInt(10_000, 30_000);
    }
    const step = Math.min(1_000, ms - waited);
    await pause(step);
    waited += step;
  }
  onHeartbeat();
  return waited;
}

// Runs feed, search, and Grow in the order the plan sampled. The feed always runs; a
// search before the feed shortens it so the session length stays about the same.
export async function runPlannedSteps(page, state, plan, optimizer, { signal, onHeartbeat = () => {}, onProgress = () => {}, steps = {} } = {}) {
  const feed = steps.feed || runLinkedInFeed;
  const search = steps.search || runSearch;
  const grow = steps.grow || runConnectionBatch;
  const dwell = steps.dwell || postInviteDwell;
  let lastInviteAt = null;
  const noteInvites = (sent) => { if (delivered(sent)) lastInviteAt = Date.now(); };
  const order = plan.order || ["feed"];
  const feedPlan = plan.search ? { ...plan, sessionMs: Math.max(5 * 60_000, plan.sessionMs - 150_000) } : plan;
  let result = null;
  const extra = { connections: 0, connectionAttempts: 0, sent: [], visits: 0, companyVisits: 0, connectionNote: null, searchQuery: null, searchOpened: false, searchNote: null, searchReturned: null };
  let block = null;
  for (const step of order) {
    signal?.throwIfAborted();
    if (step === "feed") {
      result = await feed(page, feedPlan, optimizer, { signal, onHeartbeat, onProgress });
      extra.connections += result.profileConnections || 0;
      extra.connectionAttempts += result.profileConnectAttempts || 0;
      extra.sent.push(...(result.profileSent || []));
      noteInvites(result.profileSent);
      if (signal) recordCancellation(result, signal);
      if (result.aborted) break;
    } else if (step === "search" && !plan.testRun && !plan.connectionTrial) {
      let found;
      try {
        found = await search(page, state, plan, { signal, onHeartbeat });
      } catch (error) {
        if (isInfrastructureFailure(error)) throw error;
        log.warn("Search step failed; continuing the session.", { message: error.message });
        continue;
      }
      extra.searchQuery = found.query;
      extra.searchOpened = Boolean(found.searched);
      extra.searchNote = found.reason || null;
      extra.visits += found.visits || 0;
      extra.companyVisits += found.companyVisits || 0;
      extra.searchReturned = found.returned ?? null;
      extra.connections += found.connections || 0;
      extra.connectionAttempts += found.attempted || 0;
      extra.sent.push(...(found.sent || []));
      noteInvites(found.sent);
      if (found.accountBlock) { block = found.accountBlock; break; }
    } else if (step === "grow" && !plan.testRun) {
      const connections = await grow(page, state, {
        signal,
        onHeartbeat,
        maxAttempts: plan.connectionTrial ? 1 : (plan.inviteCount ?? 0),
        growVisits: plan.growVisits || 0,
        maxDurationMs: 9 * 60_000,
      });
      extra.connections += connections.connections || 0;
      extra.connectionAttempts += connections.attempted || 0;
      extra.visits += connections.visits || 0;
      extra.sent.push(...(connections.sent || []));
      noteInvites(connections.sent);
      extra.connectionNote = connections.reason || null;
      if (connections.accountBlock) { block = connections.accountBlock; break; }
    }
  }
  // Never close the browser seconds after an invite. A checkpoint or restriction page is
  // not a place to linger; an uncertain invite still is.
  const dwellMs = postInviteDwellMs({ sent: extra.sent, lastInviteAt });
  if (dwellMs > 0 && !signal?.aborted && !result?.checkpoint && (!block || block.kind === "uncertain_connection")) {
    await dwell(page, dwellMs, { signal, onHeartbeat });
  }
  result ||= { ...blankResult(), aborted: Boolean(block) };
  result.connections = extra.connections;
  result.connectionAttempts = extra.connectionAttempts;
  result.connectionNote = extra.connectionNote;
  result.sent = extra.sent;
  result.visits = (result.visits || 0) + extra.visits;
  result.companyVisits = (result.companyVisits || 0) + extra.companyVisits;
  result.searchReturned = extra.searchReturned;
  result.searchQuery = extra.searchQuery;
  result.searchOpened = extra.searchOpened;
  result.searchNote = extra.searchNote;
  if (block) {
    result.aborted = true;
    result.accountBlock = block;
    result.reason = block.reason;
  }
  return result;
}

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
    const interrupted = state.currentRun;
    if (recoverInterruptedRun(state)) {
      log.error("Recovered an interrupted session as an infrastructure failure; previous action reservations remain consumed.");
      if (interrupted?.cloudOwned && config.gologinToken) {
        await stopCloudProfile(config.profileId, { token: config.gologinToken });
        log.info("Stopped the cloud profile left by the interrupted worker.");
      }
    }
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
    const limitAt = Date.now() + preflight.plan.sessionMs + 14 * 60_000;
    let lastHeartbeat = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      if (now - lastHeartbeat > 60_000) controller.abort(new Error("Mac slept or execution stalled; ending this session without catch-up actions"));
      if (now >= limitAt) controller.abort(new Error("Session exceeded its execution deadline"));
    }, 1000);
    notify("session_started", preflight.plan.testRun ? "Browse-only test started" : preflight.plan.connectionTrial ? "Connection trial started: zero likes, at most one invitation after browsing" : "Warm-up session started", { run: run.id });
    await flushNotifications();
    controller.signal.throwIfAborted();
    session = await openWarmupBrowser();
    state.currentRun.cloudOwned = Boolean(session.startedByUs && config.browserMode === "cloud");
    saveState(state);
    controller.signal.throwIfAborted();
    // Attach to a tab before the long settle — waiting first lets LinkedIn paint
    // wedge Orbita CDP on some local profiles (Network.enable hangs).
    const page = await getWorkingPage(session.browser);
    await sleep(Math.min(preflight.plan.settleMs, 4_000));
    controller.signal.throwIfAborted();
    const heartbeat = () => { lastHeartbeat = Date.now(); };
    const progress = (snapshot) => {
      heartbeat();
      if (!state.currentRun) return;
      state.currentRun.progress = { ...state.currentRun.progress, ...snapshot };
      saveState(state);
    };
    const result = await runPlannedSteps(page, state, preflight.plan, optimizer, {
      signal: controller.signal,
      onHeartbeat: heartbeat,
      onProgress: progress,
    });
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
    log.info("Session closed.", {
      likes: result.likes,
      postsSeen: result.postsSeen,
      expanded: result.expanded,
      seeNewPosts: result.seeNewPosts,
      follows: result.follows || 0,
      followAttempts: result.followAttempts || 0,
      visits: result.visits || 0,
      companyVisits: result.companyVisits || 0,
      searched: result.searchQuery ? true : false,
      searchOpened: Boolean(result.searchOpened),
      searchNote: result.searchNote || null,
      searchReturned: result.searchReturned ?? null,
      order: preflight.plan.order,
      connections: result.connections || 0,
      connectionAttempts: result.connectionAttempts || 0,
      connectionNote: result.connectionNote || null,
      durationMin: Math.round(result.durationMs / 6000) / 10,
      aborted: result.aborted,
      reason: result.reason || null,
    });
    notify(result.aborted ? "session_failed" : "session_completed", result.reason || "Session finished", {
      run: run.id, posts: result.postsSeen, expanded: result.expanded, likes: result.likes,
      follows: result.follows || 0,
      connections: result.connections || 0, connectionAttempts: result.connectionAttempts || 0,
      connectionNote: result.connectionNote || "none",
      sent: JSON.stringify(result.sent || []),
      minutes: (result.durationMs / 60_000).toFixed(1),
      warnings: JSON.stringify(getWarningCounts()),
    });
    return { blocked: false, result };
  } catch (error) {
    retainLock ||= Boolean(error.retainBrowserLock);
    if (state?.currentRun && optimizer && !finalized) {
      const run = state.currentRun;
      if (hasUncertainConnect(state, run.id)) {
        pauseForAccount(state, { kind: "uncertain_connection", reason: "Interrupted connection attempt requires invitation review" });
      }
      const confirmed = state.actions.filter((a) => a.runId === run.id && a.status === "confirmed");
      const progress = run.progress || {};
      const failedResult = {
        likes: Math.max(progress.likes || 0, confirmed.filter((a) => a.kind === "like").length),
        connections: confirmed.filter((a) => a.kind === "connect").length,
        follows: confirmed.filter((a) => a.kind === "follow").length,
        postsSeen: progress.postsSeen || 0,
        expanded: progress.expanded || 0,
        seeNewPosts: progress.seeNewPosts || 0,
        durationMs: Date.now() - new Date(run.at).getTime(),
        aborted: true,
        checkpoint: false,
        failureKind: failureKind(error),
        reason: error.message,
        deniedReasons: {},
      };
      optimizer.postflight(failedResult);
      if (windowKey) state.windows[windowKey].status = "failed";
      saveState(state);
      notify("session_failed", error.message, {
        run: run.id,
        posts: failedResult.postsSeen,
        expanded: failedResult.expanded,
        likes: failedResult.likes,
        connections: failedResult.connections,
        minutes: (failedResult.durationMs / 60_000).toFixed(1),
        failureKind: failedResult.failureKind,
        warnings: JSON.stringify(getWarningCounts()),
      });
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
