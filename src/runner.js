import { config } from "./config.js";
import { openWarmupBrowser } from "./browser/session.js";
import { browserOf, guardNewTabs, isDetachedFrameError, resolveLiveLinkedInPage, waitForLiveLinkedInPage } from "./browser/page.js";
import { createLogger, getWarningCounts } from "./logger.js";
import { Optimizer } from "./optimizer/reviewer.js";
import { getWorkingPage, runLinkedInFeed } from "./scenario/linkedinFeed.js";
import { runConnectionBatch } from "./scenario/linkedinNetwork.js";
import { inspectAccount, observedAccountBlock, pauseForAccount } from "./scenario/accountGuard.js";
import { loadState, saveState } from "./sessionState.js";
import { abandonRun, beginRun, hasUncertainConnect, recoverInterruptedRun, weeklyBudget } from "./activity.js";
import { isNetworkOutage, probeConnectivity } from "./util/connectivity.js";
import { GROW_OPEN_MS, INVITE_WORK_MS, boundedLingerMs, growTimeLeft } from "./sessionBudget.js";
import { claimWindow } from "./scheduler.js";
import { acquireLock } from "./lock.js";
import { flushNotifications, notify } from "./notifications/slack.js";
import { randomInt, sleep } from "./util/random.js";
import { pagePointer } from "./human/trackpad.js";
import { PRESS_TIMEOUT_MS } from "./human/press.js";
import { recordCancellation } from "./util/cancellation.js";
import { failureKind } from "./util/failures.js";
import { stopCloudProfile } from "./gologin/cloud.js";

const log = createLogger("runner");

// One original navigation plus two retries. A detached frame before any feed
// read is retried; it is not polled forever.
export const FEED_FRAME_ATTEMPTS = 3;
const FEED_FRAME_RETRY_MS = 700;
const GROW_STEP_CEILING_MS = 9 * 60_000;

// The watchdog ticks every second. A tick that arrives 30s late means the process did
// not run at all (system sleep or a blocked event loop). A single await is allowed to
// run long: feed reloads retry for ~90s and CDP calls have a 45s protocol timeout, so
// "no progress" only fires after five minutes without a heartbeat.
export const WATCHDOG_TICK_GAP_MS = 30_000;
export const WATCHDOG_NO_PROGRESS_MS = 5 * 60_000;

export function watchdogVerdict({ wallGapMs = 0, monoGapMs = wallGapMs, sinceHeartbeatMs = 0 } = {}) {
  if (wallGapMs >= WATCHDOG_TICK_GAP_MS) {
    const slept = wallGapMs - monoGapMs >= WATCHDOG_TICK_GAP_MS / 2;
    return {
      stop: true,
      kind: slept ? "sleep" : "stall",
      reason: slept
        ? "Mac slept or execution stalled; ending this session without catch-up actions"
        : "Event loop was blocked or execution stalled; ending this session without catch-up actions",
    };
  }
  if (sinceHeartbeatMs >= WATCHDOG_NO_PROGRESS_MS) {
    return { stop: true, kind: "no-progress", reason: `Session made no progress for ${Math.round(sinceHeartbeatMs / 60_000)} minutes; ending it as an infrastructure failure` };
  }
  return { stop: false };
}

function blankResult() {
  return { likes: 0, postsSeen: 0, expanded: 0, seeNewPosts: 0, durationMs: 0, aborted: false, checkpoint: false, deniedReasons: {} };
}

function feedWorkRecorded(progress) {
  if (!progress) return false;
  return (progress.postsSeen || 0) > 0 || (progress.likes || 0) > 0 || (progress.expanded || 0) > 0;
}

function countsFrom(progress) {
  return {
    likes: progress?.likes || 0,
    postsSeen: progress?.postsSeen || 0,
    expanded: progress?.expanded || 0,
    seeNewPosts: progress?.seeNewPosts || 0,
  };
}

// A detached frame cannot be inspected, so its cached URL and the browser's page targets are
// checked instead. A login wall must never be hidden behind a frame error.
async function liveAccountBlock(page) {
  if (!page) return null;
  try {
    return await inspectAccount(page);
  } catch (error) {
    if (isDetachedFrameError(error)) return observedAccountBlock(browserOf(page), page);
    throw error;
  }
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

// Feed always runs. My Network runs only when the plan drew invitations. Search is ignored:
// opening a profile from search is a profile view, and Connect from a profile is not allowed.
// Any aborted session that ends with a LinkedIn login, authwall, /hp, or checkpoint visible in
// a tab is an account stop, whatever step reported the failure. It is never infra or retried.
export async function accountWallGuard(result, browser, page = null) {
  if (!result?.aborted || result.accountBlock || result.failureKind === "operator") return result;
  const wall = await observedAccountBlock(browser, page).catch(() => null);
  if (!wall) return result;
  log.warn("A LinkedIn account wall is open; this failure is an account stop, not infrastructure.", { kind: wall.kind, url: wall.url, was: result.reason || null });
  result.accountBlock = wall;
  result.checkpoint = true;
  result.failureKind = "scenario";
  result.reason = wall.reason;
  return result;
}

// plannedMin is the sampled budget; budgetedMin is measured from the first feed action and is
// what the budget enforces; totalMin also includes browser startup.
export function sessionMinutes(plan, result) {
  const minutes = (ms) => (Number.isFinite(ms) ? Math.round(ms / 6000) / 10 : null);
  return {
    plannedMin: minutes(plan?.sessionMs),
    budgetedMin: minutes(result?.budgetedMs),
    totalMin: minutes(result?.durationMs),
  };
}

export async function runPlannedSteps(page, state, plan, optimizer, { signal, onHeartbeat = () => {}, onProgress = () => {}, steps = {}, frameWait = sleep, clock = Date.now } = {}) {
  const feed = steps.feed || runLinkedInFeed;
  const grow = steps.grow || runConnectionBatch;
  const dwell = steps.dwell || postInviteDwell;
  let lastInviteAt = null;
  const noteInvites = (sent) => { if (delivered(sent)) lastInviteAt = clock(); };
  const order = plan.order || ["feed"];
  // plan.sessionMs is the whole session: feed, My Network, and the post-invite linger.
  const stepsStartedAt = clock();
  const sessionEndsAt = plan.sessionMs > 0 ? stepsStartedAt + plan.sessionMs : Infinity;
  const feedPlan = plan.feedMs > 0 ? { ...plan, sessionMs: plan.feedMs } : plan;
  let result = null;
  const extra = { connections: 0, connectionAttempts: 0, sent: [], visits: 0, companyVisits: 0, connectionNote: null, searchQuery: null, searchOpened: false, searchNote: null, searchReturned: null };
  let block = null;
  for (const step of order) {
    signal?.throwIfAborted();
    if (step === "feed") {
      const tracked = { likes: 0, postsSeen: 0, expanded: 0, seeNewPosts: 0 };
      let lastDetach = null;
      const report = (snapshot) => {
        if (snapshot && typeof snapshot === "object") Object.assign(tracked, snapshot);
        onProgress(snapshot);
      };
      let attempts = 0;
      let runFeed = true;
      while (attempts < FEED_FRAME_ATTEMPTS) {
        attempts += 1;
        try {
          // The feed is only re-run on a freshly resolved live page, never on the frame that
          // already detached.
          if (!runFeed) throw Object.assign(new Error(lastDetach || "Attempted to use detached Frame"), { reResolve: true });
          result = await feed(page, feedPlan, optimizer, { signal, onHeartbeat, onProgress: report });
          break;
        } catch (error) {
          if (!isDetachedFrameError(error)) throw error;
          lastDetach = error.message;
          const browser = browserOf(page);
          const wall = await observedAccountBlock(browser, page);
          const live = wall ? null : await waitForLiveLinkedInPage(browser, { pause: frameWait, attempts: 3 });
          runFeed = Boolean(live);
          const accountBlock = wall || await liveAccountBlock(live);
          // A challenge on the live tab is an account stop. Frame recovery must not
          // record it as a completed browse.
          if (accountBlock) {
            if (live) page = live;
            result = {
              ...blankResult(),
              ...countsFrom(tracked),
              aborted: true,
              checkpoint: ["challenge", "restriction", "login"].includes(accountBlock.kind),
              accountBlock,
              reason: accountBlock.reason,
            };
            break;
          }
          if (feedWorkRecorded(tracked)) {
            if (live) page = live;
            log.warn("Detached frame after the feed had already browsed. Keeping that result.", {
              message: error.message,
              likes: tracked.likes,
              postsSeen: tracked.postsSeen,
              expanded: tracked.expanded,
            });
            result = { ...blankResult(), ...countsFrom(tracked), aborted: false, checkpoint: false };
            break;
          }
          log.warn(runFeed ? "Detached frame before the feed was readable. Retrying on a live page." : "Detached frame before the feed was readable and no live LinkedIn page yet. Re-resolving from the browser.", {
            attempt: attempts,
            maxAttempts: FEED_FRAME_ATTEMPTS,
            message: error.message,
          });
          if (live) page = live;
          if (attempts >= FEED_FRAME_ATTEMPTS) {
            result = {
              ...blankResult(),
              aborted: true,
              checkpoint: false,
              failureKind: "infra",
              reason: `Feed frame detached before any posts were read after ${attempts} navigation attempts.`,
            };
            break;
          }
          await frameWait(FEED_FRAME_RETRY_MS);
        }
      }
      extra.connections += result.profileConnections || 0;
      extra.connectionAttempts += result.profileConnectAttempts || 0;
      extra.sent.push(...(result.profileSent || []));
      noteInvites(result.profileSent);
      if (signal) recordCancellation(result, signal);
      if (result.aborted) break;
      if (result.pageLost) {
        const live = await waitForLiveLinkedInPage(browserOf(page), { pause: frameWait });
        if (!live) {
          log.warn("The feed tab closed after a productive browse and no LinkedIn tab is left. Skipping later steps.", { postsSeen: result.postsSeen });
          extra.connectionNote = "Skipped: the LinkedIn tab closed after the feed";
          break;
        }
        page = live;
      }
    } else if (step === "search") {
      log.info("Skipping search. Profile pages stay closed, and connection requests stay on My Network.");
    } else if (step === "grow" && !plan.testRun) {
      const growMs = Number.isFinite(sessionEndsAt) ? growTimeLeft(sessionEndsAt, clock()) : GROW_STEP_CEILING_MS;
      if (growMs < GROW_OPEN_MS + INVITE_WORK_MS) {
        log.info("Skipping My Network: the session time budget has no room left for an invitation.", { secondsLeft: Math.round(Math.max(0, sessionEndsAt - clock()) / 1000) });
        extra.connectionNote = "Skipped: session time budget left no room for My Network";
        continue;
      }
      let connections;
      try {
        connections = await grow(page, state, {
          signal,
          onHeartbeat,
          maxAttempts: plan.connectionTrial ? 1 : (plan.inviteCount ?? 0),
          growVisits: plan.growVisits || 0,
          maxDurationMs: Math.min(GROW_STEP_CEILING_MS, growMs),
          clock,
        });
      } catch (error) {
        const keepFeed = isDetachedFrameError(error) && result && !result.aborted && feedWorkRecorded(result);
        if (!keepFeed || (state?.currentRun && hasUncertainConnect(state, state.currentRun.id))) throw error;
        const accountBlock = await liveAccountBlock(await resolveLiveLinkedInPage(browserOf(page)));
        if (accountBlock) {
          connections = { connections: 0, attempted: 0, sent: [], reason: accountBlock.reason, accountBlock };
        } else {
          log.warn("Detached frame during My Network after a productive feed. Keeping the feed result.", { message: error.message });
          connections = { connections: 0, attempted: 0, sent: [], reason: "My Network stopped because the page frame detached" };
        }
      }
      extra.connections += connections.connections || 0;
      extra.connectionAttempts += connections.attempted || 0;
      extra.visits += connections.visits || 0;
      extra.sent.push(...(connections.sent || []));
      noteInvites(connections.sent);
      extra.connectionNote = connections.reason || null;
      if (connections.page) page = connections.page;
      if (connections.accountBlock) { block = connections.accountBlock; break; }
    }
  }
  // Never close the browser seconds after an invite. A checkpoint or restriction page is
  // not a place to linger; an uncertain invite still is.
  const sampledDwellMs = postInviteDwellMs({ sent: extra.sent, lastInviteAt, now: clock() });
  const dwellMs = Number.isFinite(sessionEndsAt) ? boundedLingerMs(sampledDwellMs, sessionEndsAt, clock()) : sampledDwellMs;
  if (dwellMs > 0 && !signal?.aborted && !result?.checkpoint && (!block || block.kind === "uncertain_connection")) {
    try {
      await dwell(page, dwellMs, { signal, onHeartbeat });
    } catch (error) {
      const keepFeed = isDetachedFrameError(error) && result && !result.aborted && feedWorkRecorded(result);
      if (!keepFeed || (state?.currentRun && hasUncertainConnect(state, state.currentRun.id))) throw error;
      block = await liveAccountBlock(await resolveLiveLinkedInPage(browserOf(page)));
      if (!block) log.warn("Detached frame while staying on LinkedIn after an invite. Keeping the session result.", { message: error.message });
    }
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
  // The budget is measured from the first feed action; durationMs also covers browser startup.
  result.budgetedMs = clock() - stepsStartedAt;
  return result;
}

export async function runSession({ windowKey, checkConnectivity = probeConnectivity } = {}) {
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
    if (!state.pause) {
      const reach = await checkConnectivity();
      if (!reach.ok) {
        const reason = `GoLogin unreachable before start (${reach.reason}). The profile was not started and the session was not counted.`;
        log.warn("Deferring this profile: GoLogin is unreachable.", { reason: reach.reason });
        return { blocked: true, deferred: true, reason };
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
    let lastTickWall = Date.now();
    let lastTickMono = performance.now();
    timer = setInterval(() => {
      const now = Date.now();
      const mono = performance.now();
      const verdict = watchdogVerdict({ wallGapMs: now - lastTickWall, monoGapMs: mono - lastTickMono, sinceHeartbeatMs: now - lastHeartbeat });
      lastTickWall = now;
      lastTickMono = mono;
      if (verdict.stop && !controller.signal.aborted) {
        log.warn("Session watchdog stopped the run.", { kind: verdict.kind, sinceHeartbeatSec: Math.round((now - lastHeartbeat) / 1000) });
        controller.abort(new Error(verdict.reason));
      }
      if (now >= limitAt) controller.abort(new Error("Session exceeded its execution deadline"));
    }, 1000);
    notify("session_started", preflight.plan.testRun ? "Browse-only test started" : preflight.plan.connectionTrial ? "Connection trial started: zero likes, at most one invitation after browsing" : "Warm-up session started", { run: run.id });
    await flushNotifications();
    controller.signal.throwIfAborted();
    try {
      session = await openWarmupBrowser();
    } catch (error) {
      // Nothing was started and no action reserved: give the run back instead of
      // recording a failed session, so the batch can retry this profile later.
      if (isNetworkOutage(error) && abandonRun(state, run.id)) {
        if (windowKey) state.windows[windowKey].status = "scheduled";
        saveState(state);
        finalized = true;
        log.warn("GoLogin was unreachable before the browser opened. The session was not counted.", { message: error.message });
        notify("session_deferred", error.message);
        return { blocked: true, deferred: true, reason: error.message };
      }
      throw error;
    }
    state.currentRun.cloudOwned = Boolean(session.startedByUs && config.browserMode === "cloud");
    saveState(state);
    controller.signal.throwIfAborted();
    // Attach to a tab before the long settle — waiting first lets LinkedIn paint
    // wedge Orbita CDP on some local profiles (Network.enable hangs).
    const page = await getWorkingPage(session.browser);
    guardNewTabs(session.browser, { log });
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
    await accountWallGuard(result, session.browser, page);
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
      ...sessionMinutes(preflight.plan, result),
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
    // The batch runner keys on this line: a run with no browser does not use its proxy port.
    if (!session && !retainLock && !error.browserLaunched) log.warn("No browser was started for this session; its proxy port was not used.");
    const progress = state?.currentRun?.progress || {};
    // A frame drop after posts were already browsed is not an account failure and
    // must not be rethrown. Exit status follows result.aborted, so this returns
    // a completed session instead of killing the process.
    if (isDetachedFrameError(error) && state?.currentRun && optimizer && !finalized && feedWorkRecorded(progress) && !hasUncertainConnect(state, state.currentRun.id)) {
      const run = state.currentRun;
      let accountBlock = null;
      try {
        accountBlock = await liveAccountBlock(await resolveLiveLinkedInPage(session?.browser));
      } catch (inspectError) {
        log.warn("Could not re-check the account after a detached frame.", { message: inspectError.message });
      }
      if (!accountBlock) {
        const confirmed = state.actions.filter((a) => a.runId === run.id && a.status === "confirmed");
        const preserved = {
          ...blankResult(),
          ...countsFrom(progress),
          likes: Math.max(progress.likes || 0, confirmed.filter((a) => a.kind === "like").length),
          connections: confirmed.filter((a) => a.kind === "connect").length,
          follows: confirmed.filter((a) => a.kind === "follow").length,
          durationMs: Date.now() - new Date(run.at).getTime(),
          aborted: false,
          checkpoint: false,
        };
        optimizer.postflight(preserved);
        if (windowKey) state.windows[windowKey].status = "completed";
        saveState(state);
        finalized = true;
        log.warn("Detached frame after a productive feed. Keeping the feed result.", {
          message: error.message,
          likes: preserved.likes,
          postsSeen: preserved.postsSeen,
        });
        log.info("Session closed.", {
          likes: preserved.likes,
          postsSeen: preserved.postsSeen,
          expanded: preserved.expanded,
          seeNewPosts: preserved.seeNewPosts,
          follows: preserved.follows || 0,
          connections: preserved.connections || 0,
          durationMin: Math.round(preserved.durationMs / 6000) / 10,
          aborted: false,
          reason: null,
        });
        notify("session_completed", "Session finished", {
          run: run.id,
          posts: preserved.postsSeen,
          expanded: preserved.expanded,
          likes: preserved.likes,
          connections: preserved.connections || 0,
          minutes: (preserved.durationMs / 60_000).toFixed(1),
          warnings: JSON.stringify(getWarningCounts()),
        });
        return { blocked: false, result: preserved };
      }
      pauseForAccount(state, accountBlock);
      saveState(state);
      notify("profile_paused", accountBlock.reason, { action: "Open this profile manually, resolve the issue, then run resume --reviewed" });
      const challenged = {
        ...blankResult(),
        ...countsFrom(progress),
        durationMs: Date.now() - new Date(run.at).getTime(),
        aborted: true,
        checkpoint: ["challenge", "restriction", "login"].includes(accountBlock.kind),
        accountBlock,
        reason: accountBlock.reason,
      };
      optimizer.postflight(challenged);
      if (windowKey) state.windows[windowKey].status = "failed";
      saveState(state);
      finalized = true;
      log.info("Session closed.", {
        likes: challenged.likes,
        postsSeen: challenged.postsSeen,
        expanded: challenged.expanded,
        durationMin: Math.round(challenged.durationMs / 6000) / 10,
        aborted: true,
        reason: challenged.reason,
      });
      notify("session_failed", accountBlock.reason, {
        run: run.id,
        posts: challenged.postsSeen,
        likes: challenged.likes,
        minutes: (challenged.durationMs / 60_000).toFixed(1),
      });
      return { blocked: false, result: challenged };
    }
    if (state?.currentRun && optimizer && !finalized) {
      const run = state.currentRun;
      if (hasUncertainConnect(state, run.id)) {
        pauseForAccount(state, { kind: "uncertain_connection", reason: "Interrupted connection attempt requires invitation review" });
      }
      const confirmed = state.actions.filter((a) => a.runId === run.id && a.status === "confirmed");
      const progress = run.progress || {};
      const detached = isDetachedFrameError(error);
      const uncertain = hasUncertainConnect(state, run.id);
      // A login wall visible in any tab is an account stop, whatever error ended the run.
      const wall = session && !state.pause ? await observedAccountBlock(session.browser).catch(() => null) : null;
      if (wall) {
        pauseForAccount(state, wall);
        notify("profile_paused", wall.reason, { action: "Open this profile manually, resolve the issue, then run resume --reviewed" });
        log.warn("A LinkedIn account wall was open when the session failed. Pausing the profile.", { kind: wall.kind, url: wall.url });
      }
      const failedResult = {
        likes: Math.max(progress.likes || 0, confirmed.filter((a) => a.kind === "like").length),
        connections: confirmed.filter((a) => a.kind === "connect").length,
        follows: confirmed.filter((a) => a.kind === "follow").length,
        postsSeen: progress.postsSeen || 0,
        expanded: progress.expanded || 0,
        seeNewPosts: progress.seeNewPosts || 0,
        durationMs: Date.now() - new Date(run.at).getTime(),
        aborted: true,
        checkpoint: Boolean(wall),
        failureKind: wall ? "scenario" : detached && !uncertain ? "infra" : failureKind(error),
        reason: wall ? wall.reason : detached && !uncertain
          ? `Feed frame detached before the session could finish. ${error.message}`
          : error.message,
        deniedReasons: {},
      };
      error.sessionFailureKind = wall ? "account" : failedResult.failureKind;
      optimizer.postflight(failedResult);
      if (windowKey) state.windows[windowKey].status = "failed";
      saveState(state);
      notify("session_failed", failedResult.reason, {
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
