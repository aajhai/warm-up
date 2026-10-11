import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "warmup-failure-modes-"));
process.env.WARMUP_DATA_DIR = root;
process.env.WARMUP_LOG_DIR = join(root, "logs");
process.env.GL_PROFILE_NAME = "Fixture";
process.env.GL_PROFILE_ID = "fixture-failure-modes";

const { isNetworkOutage, failureKind, isOperatorStop } = await import("../src/util/failures.js");
const { probeConnectivity, waitForConnectivity, backoffMs } = await import("../src/util/connectivity.js");
const { emptyState } = await import("../src/sessionState.js");
const { abandonRun, beginRun } = await import("../src/activity.js");
const { Optimizer } = await import("../src/optimizer/reviewer.js");
const { sessionFailureKind, EXIT_DEFERRED } = await import("../src/index.js");
const { runPlannedSteps, watchdogVerdict, WATCHDOG_NO_PROGRESS_MS } = await import("../src/runner.js");
const { LocalProfileLauncher, settleStartupNavigation, startupPageKind } = await import("../src/gologin/local.js");
const { isDetachedFrameError, waitForLiveLinkedInPage } = await import("../src/browser/page.js");
const { TrustedPointer } = await import("../src/human/trackpad.js");
const { approveExpand, recoverThinFeedFollows, thinFollowGate, getWorkingPage, START_TAB_LINKEDIN_LOADS, actOnShortColumn, awaitShortColumnPaint, feedLoadTrouble, noteFeedProgress, FEED_STALL_MS } = await import("../src/scenario/linkedinFeed.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

const quiet = async () => {};
const enotfound = () => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.gologin.com"), { code: "ENOTFOUND" }) });

// Case 1: network / GoLogin API outage

test("a DNS failure reaching api.gologin.com is an outage; an HTTP error from GoLogin is not", () => {
  assert.equal(isNetworkOutage(enotfound()), true);
  assert.equal(isNetworkOutage(new Error("GoLogin's local API is unavailable. Open GoLogin.app and retry.")), true);
  assert.equal(isNetworkOutage(Object.assign(new Error("GET /browser/x -> 401 Unauthorized"), { status: 401 })), false);
  assert.equal(isNetworkOutage(new Error("Protocol error (Runtime.callFunctionOn): Target closed")), false);
});

test("the connectivity probe needs both the GoLogin API and the local desktop API", async () => {
  const up = await probeConnectivity({ fetchImpl: async () => new Response("ok", { status: 404 }) });
  assert.equal(up.ok, true, "any HTTP answer counts as reachable");
  const dnsDown = await probeConnectivity({
    fetchImpl: async (url) => { if (String(url).includes("gologin.com")) throw enotfound(); return new Response("", { status: 200 }); },
  });
  assert.equal(dnsDown.ok, false);
  assert.match(dnsDown.reason, /GoLogin API ENOTFOUND/);
  assert.doesNotMatch(dnsDown.reason, /local API/);
  const appClosed = await probeConnectivity({
    fetchImpl: async (url) => {
      if (String(url).includes("127.0.0.1")) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      return new Response("", { status: 200 });
    },
  });
  assert.equal(appClosed.ok, false);
  assert.match(appClosed.reason, /local API ECONNREFUSED/);
});

test("the outage wait backs off, resumes as soon as GoLogin answers, and gives up after its budget", async () => {
  const waits = [];
  let checks = 0;
  const back = await waitForConnectivity({
    probe: async () => ({ ok: (checks += 1) >= 4, reason: "GoLogin API ENOTFOUND" }),
    pause: async (ms) => { waits.push(ms); },
  });
  assert.equal(back.ok, true);
  assert.deepEqual(waits, [15_000, 30_000, 60_000]);

  const longWaits = [];
  const gone = await waitForConnectivity({
    probe: async () => ({ ok: false, reason: "GoLogin API ENOTFOUND" }),
    budgetMs: 15 * 60_000,
    pause: async (ms) => { longWaits.push(ms); },
  });
  assert.equal(gone.ok, false);
  assert.equal(gone.waitedMs, 15 * 60_000);
  assert.ok(longWaits.every((ms) => ms <= backoffMs(99)), "each wait is capped");
});

test("a run abandoned before the browser opened is not a session, and a run with a reservation is never abandoned", () => {
  const state = emptyState();
  state.enrolledAt = new Date(Date.now() - 30 * 86400_000).toISOString();
  const run = beginRun(state, { testRun: false }, new Date(), () => {});
  const day = Object.values(state.daily)[0];
  assert.equal(day.sessions, 1);
  assert.equal(abandonRun(state, run.id, () => {}), true);
  assert.equal(state.currentRun, null);
  assert.equal(day.sessions, 0);
  assert.equal(day.aborted, 0);
  assert.equal(day.infraFailures || 0, 0);
  assert.equal(state.history.length, 0, "no failed session is recorded");

  const reserved = emptyState();
  reserved.enrolledAt = new Date(Date.now() - 30 * 86400_000).toISOString();
  const kept = beginRun(reserved, { testRun: false }, new Date(), () => {});
  reserved.actions.push({ id: "a1", runId: kept.id, kind: "like", status: "reserved" });
  assert.equal(abandonRun(reserved, kept.id, () => {}), false);
  assert.ok(reserved.currentRun, "a run with a reserved action goes through normal failure handling");
});

test("a refused GoLogin desktop socket is a deferrable outage that does not retain the browser lock", async () => {
  const launcher = new LocalProfileLauncher({
    token: "fixture-token",
    fetchImpl: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); },
  });
  await assert.rejects(() => launcher.start("fixture"), (error) => {
    assert.equal(isNetworkOutage(error), true);
    assert.equal(error.retainBrowserLock, false);
    return true;
  });
});

test("the batch sees a deferral and the failure kind it needs for retries", () => {
  assert.equal(EXIT_DEFERRED, 75);
  assert.equal(sessionFailureKind({ aborted: true, failureKind: "infra" }), "infra");
  assert.equal(sessionFailureKind({ aborted: true, accountBlock: { kind: "uncertain_connection" }, failureKind: "infra" }), "account");
  assert.equal(sessionFailureKind({ aborted: true }), "scenario");
});

// Case 9: operator stops are not failures

test("an operator interrupt is not an account failure or an infrastructure failure", () => {
  const error = new Error("Session interrupted by operator");
  assert.equal(isOperatorStop(error), true);
  assert.equal(failureKind(error), "operator");
  const state = emptyState();
  beginRun(state, { testRun: false }, new Date(), () => {});
  const optimizer = new Optimizer(state);
  optimizer.plan = { testRun: false };
  optimizer.postflight({ likes: 0, postsSeen: 6, expanded: 0, durationMs: 1000, aborted: true, checkpoint: false, failureKind: "operator", reason: error.message, deniedReasons: {} });
  const day = Object.values(state.daily)[0];
  assert.equal(day.aborted, 0);
  assert.equal(day.infraFailures || 0, 0);
  assert.equal(day.sessions, 0);
  assert.equal(state.history.at(-1).outcome, "interrupted");
});

test("a slow paint or loading screen is infrastructure, not an account failure", () => {
  assert.equal(failureKind(new Error("Working tab is not LinkedIn yet (chrome-error://chromewebdata/)")), "infra");
  assert.equal(failureKind(new Error("Feed rendered without readable posts")), "scenario");
});

// Case 6: watchdog

test("one long await is not mistaken for sleep; a late tick or five quiet minutes are", () => {
  assert.equal(watchdogVerdict({ wallGapMs: 1_000, monoGapMs: 1_000, sinceHeartbeatMs: 90_000 }).stop, false, "a 90s feed reload retry is not a stall");
  const slept = watchdogVerdict({ wallGapMs: 600_000, monoGapMs: 1_000, sinceHeartbeatMs: 600_000 });
  assert.equal(slept.stop, true);
  assert.equal(slept.kind, "sleep");
  assert.match(slept.reason, /Mac slept/);
  const blocked = watchdogVerdict({ wallGapMs: 40_000, monoGapMs: 40_000, sinceHeartbeatMs: 40_000 });
  assert.equal(blocked.kind, "stall");
  const quietRun = watchdogVerdict({ wallGapMs: 1_000, monoGapMs: 1_000, sinceHeartbeatMs: WATCHDOG_NO_PROGRESS_MS });
  assert.equal(quietRun.kind, "no-progress");
  assert.equal(failureKind(new Error(quietRun.reason)), "infra");
});

// Case 5: missing debugger endpoint

function emptyWsLauncher({ lingering = 0 } = {}) {
  let now = 0;
  let listings = 0;
  const calls = [];
  const launcher = new LocalProfileLauncher({
    token: "fixture-token",
    now: () => now,
    pause: async (ms) => { now += ms; },
    listProcesses: async () => {
      listings += 1;
      return listings > 1 && listings <= 1 + lingering ? "/Applications/Orbita-Browser.app/Contents/MacOS/Orbita --user-data-dir=/x/GoLogin/profiles/fixture" : "";
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("start-profile")) return Response.json({ status: "success", wsUrl: "" });
      return new Response(null, { status: 204 });
    },
  });
  return { launcher, calls, elapsed: () => now };
}

test("a start with no debugger endpoint is bounded, stops the profile, releases the lock, and is infrastructure", async () => {
  const { launcher, calls, elapsed } = emptyWsLauncher();
  launcher.discoverDebuggerUrl = async () => null;
  await assert.rejects(() => launcher.start("fixture"), (error) => {
    assert.equal(failureKind(error), "infra");
    assert.notEqual(error.retainBrowserLock, true);
    assert.match(error.message, /without a local debugger endpoint/);
    return true;
  });
  assert.ok(calls.some((url) => url.includes("stop-profile")), "GoLogin was asked to stop the profile");
  assert.ok(elapsed() < 60_000);
});

test("discovery gives up at its deadline, and an Orbita that will not exit keeps the lock", async () => {
  const { launcher } = emptyWsLauncher({ lingering: 1_000 });
  await assert.rejects(() => launcher.start("fixture"), (error) => {
    assert.equal(error.retainBrowserLock, true);
    assert.match(error.message, /still running/);
    return true;
  });
});

// Case 7: startup tab

test("fingerprint-checker start tabs are pointed at the feed like Gmail", async () => {
  for (const url of ["https://iphey.com/", "https://pixelscan.net/", "https://www.browserscan.net/"]) {
    assert.equal(startupPageKind(url), "web-start");
  }
  let url = "https://iphey.com/";
  const navigations = [];
  const settled = await settleStartupNavigation({
    listTargets: async () => [{ url }],
    navigate: async (_target, feed) => { navigations.push(feed); url = feed; },
    pause: quiet,
  });
  assert.equal(settled.kind, "linkedin");
  assert.deepEqual(navigations, ["https://www.linkedin.com/feed/"]);
});

function tab(href, events) {
  return {
    href,
    url() { return this.href; },
    goto: async function goto(target) { events.push(["goto", this.href, target]); this.href = this.nextHref ?? target; },
    bringToFront: async function bringToFront() { events.push(["front", this.href]); },
    createCDPSession: async () => ({
      send: async (method) => (method === "Target.getTargetInfo" ? { targetInfo: { targetId: "t" } } : { windowId: 1, bounds: { windowState: "normal" } }),
      detach: async () => {},
    }),
  };
}

test("an iphey start tab gets one LinkedIn load and no input; the LinkedIn tab is the working tab", async () => {
  const events = [];
  const iphey = tab("https://iphey.com/", events);
  const page = await getWorkingPage({ pages: async () => [iphey] }, { pause: quiet });
  assert.equal(page, iphey);
  assert.deepEqual(events[0], ["goto", "https://iphey.com/", "https://www.linkedin.com/feed/"]);
  assert.equal(events.filter(([kind, href]) => kind === "front" && !/linkedin/.test(href)).length, 0, "the checker tab was never foregrounded");
});

test("a start tab that stays on chrome-error fails as infrastructure after bounded loads, never foregrounded", async () => {
  const events = [];
  const broken = tab("chrome-error://chromewebdata/", events);
  broken.nextHref = "chrome-error://chromewebdata/";
  const other = tab("https://pixelscan.net/", events);
  other.goto = async () => { throw new Error("other tabs get no input"); };
  await assert.rejects(() => getWorkingPage({ pages: async () => [other, broken] }, { pause: quiet, attempts: 6 }), (error) => {
    assert.equal(failureKind(error), "infra");
    assert.match(error.message, /not paused/);
    return true;
  });
  assert.equal(events.filter(([kind]) => kind === "goto").length, START_TAB_LINKEDIN_LOADS);
  assert.equal(events.filter(([kind]) => kind === "front").length, 0);
});

test("when a LinkedIn tab exists, checker tabs are ignored entirely", async () => {
  const events = [];
  const checker = tab("https://www.browserscan.net/", events);
  const feed = tab("https://www.linkedin.com/feed/", events);
  const page = await getWorkingPage({ pages: async () => [checker, feed] }, { pause: quiet });
  assert.equal(page, feed);
  assert.deepEqual(events, [["front", "https://www.linkedin.com/feed/"]]);
});

// Case 4: detached frame / closed target

test("a closed or swapped target is a lost page, the same as a detached frame", () => {
  for (const message of [
    "Protocol error (Runtime.callFunctionOn): Target closed",
    "Navigating frame was detached",
    "Protocol error (Input.dispatchMouseEvent): Session closed. Most likely the page has been closed.",
    "Attempted to use detached Frame '7734A7AAC6DD2625AACF40C8EC03C588'.",
  ]) assert.equal(isDetachedFrameError(new Error(message)), true, message);
  assert.equal(isDetachedFrameError(new Error("Protocol error: Connection closed.")), false);
});

test("a pointer on a closed page is not a stall: no retry, no bring-to-front, and later input fails fast", async () => {
  let sends = 0;
  let fronts = 0;
  const page = {
    bringToFront: async () => { fronts += 1; },
    createCDPSession: async () => ({
      send: async () => { sends += 1; throw new Error("Protocol error (Input.dispatchMouseEvent): Session closed. Most likely the page has been closed."); },
      detach: async () => {},
    }),
  };
  const pointer = new TrustedPointer(page);
  await assert.rejects(() => pointer.wheel(120), /Session closed/);
  assert.equal(sends, 1, "the closed-target error is not re-sent");
  assert.equal(fronts, 0);
  assert.equal(pointer.strikes, 0);
  await assert.rejects(() => pointer.wheel(120), /Target closed/);
  assert.equal(sends, 1);
});

test("the live LinkedIn tab is found once the replacement target appears", async () => {
  let calls = 0;
  const live = { url: () => "https://www.linkedin.com/feed/", evaluate: async () => true };
  const browser = { pages: async () => ((calls += 1) < 3 ? [] : [live]) };
  assert.equal(await waitForLiveLinkedInPage(browser, { pause: quiet }), live);
  assert.equal(await waitForLiveLinkedInPage({ pages: async () => { throw new Error("Protocol error: Connection closed."); } }, { pause: quiet }), null);
});

test("Sonu: Target closed after eight browsed posts keeps the feed result", async () => {
  const live = { url: () => "https://www.linkedin.com/feed/", evaluate: async () => ({ overlays: [], chromePresent: true, bodyText: "" }) };
  const browser = { pages: async () => [live] };
  const dead = { url: () => "https://www.linkedin.com/feed/", evaluate: async () => { throw new Error("Protocol error (Runtime.callFunctionOn): Target closed"); }, browser: () => browser };
  const result = await runPlannedSteps(dead, {}, { order: ["feed"] }, null, {
    frameWait: quiet,
    steps: {
      feed: async (_page, _plan, _optimizer, { onProgress }) => {
        onProgress({ likes: 0, postsSeen: 8, expanded: 1, seeNewPosts: 0 });
        throw new Error("Protocol error (Runtime.callFunctionOn): Target closed");
      },
    },
  });
  assert.equal(result.aborted, false);
  assert.equal(result.postsSeen, 8);
});

test("Kamlesh: a productive feed whose tab closed moves later steps to a live tab, or skips them", async () => {
  const live = { url: () => "https://www.linkedin.com/feed/", evaluate: async () => true };
  let grownOn = null;
  const feed = async () => ({ likes: 1, postsSeen: 24, expanded: 8, aborted: false, pageLost: true, reason: "Feed tab closed after 24 posts; the browse result was kept" });
  const withLive = await runPlannedSteps({ browser: () => ({ pages: async () => [live] }) }, {}, { order: ["feed", "grow"], inviteCount: 1 }, null, {
    frameWait: quiet,
    steps: { feed, grow: async (page) => { grownOn = page; return { connections: 0, attempted: 0, sent: [] }; } },
  });
  assert.equal(withLive.aborted, false);
  assert.equal(grownOn, live);

  let grew = false;
  const none = await runPlannedSteps({ browser: () => ({ pages: async () => [] }) }, {}, { order: ["feed", "grow"], inviteCount: 1 }, null, {
    frameWait: quiet,
    steps: { feed, grow: async () => { grew = true; return { connections: 0, attempted: 0, sent: [] }; } },
  });
  assert.equal(none.aborted, false);
  assert.equal(none.postsSeen, 24);
  assert.equal(grew, false);
  assert.match(none.connectionNote, /closed/);
});

// Cases 2 and 3: short / half-painted feed

test("a short column that grows while painting is not revived", async () => {
  const shots = [
    { readyState: "complete", pendingImages: 2, feedHeight: 500, maxTop: 273, railText: 200, railControls: 6 },
    { readyState: "complete", pendingImages: 0, feedHeight: 1400, maxTop: 1512, railText: 200, railControls: 6 },
  ];
  let i = 0;
  const paint = await awaitShortColumnPaint({ readSnapshot: async () => shots[Math.min(i++, shots.length - 1)], readCount: async () => 3, pause: quiet });
  assert.equal(paint.grown, true);
});

test("a column that never settles is still loading; a steady short column is painted", async () => {
  let h = 400;
  const loading = await awaitShortColumnPaint({ readSnapshot: async () => ({ readyState: "complete", skeletons: 1, feedHeight: (h += 10), maxTop: 300 }), readCount: async () => 2, pause: quiet });
  assert.equal(loading.stillLoading, true);
  const steady = await awaitShortColumnPaint({ readSnapshot: async () => ({ readyState: "complete", pendingImages: 0, skeletons: 0, feedHeight: 1000, maxTop: 430, railText: 300, railControls: 8 }), readCount: async () => 3, pause: quiet });
  assert.equal(steady.painted, true);
  assert.equal(steady.stillLoading, false);
  assert.equal(steady.grown, false);
});

test("no Follow and no See new posts press on a half-painted short feed", async () => {
  const clicks = [];
  const human = { postsCacheAt: 0, clickAt: async (...args) => { clicks.push(args); return true; } };
  const page = { url: () => "https://www.linkedin.com/feed/", reload: async () => { throw new Error("no reload"); }, goto: async () => { throw new Error("no goto"); } };
  const stats = { postsSeen: 2, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 };
  const observed = { postsSeen: 2, maxTop: 696, firstTop: 224, visibleUpdates: 4, url: page.url(), pill: { x: 600, y: 200, label: "New posts" } };
  const result = await actOnShortColumn(page, human, stats, observed, {
    pause: quiet, waitMs: 0, countUnique: async () => 2,
    settle: async () => ({ grown: false, painted: false, stillLoading: true, reason: "images", postsSeen: 2, snapshot: { maxTop: 696 } }),
  });
  assert.equal(result.stillLoading, true);
  assert.equal(clicks.length, 0);
  assert.equal(stats.loadingSeen, true);

  const grown = await actOnShortColumn(page, human, { postsSeen: 2 }, observed, {
    pause: quiet, waitMs: 0, countUnique: async () => 6,
    settle: async () => ({ grown: true, painted: true, stillLoading: false, postsSeen: 6, snapshot: { maxTop: 1512 } }),
  });
  assert.equal(grown.acted, false);
  assert.equal(grown.scroll, true);
  assert.equal(clicks.length, 0);
});

test("Gopal: a feed that keeps scrolling but adds no posts recovers twice, then ends", () => {
  const stats = { postsSeen: 3 };
  let now = 0;
  assert.equal(noteFeedProgress(stats, now), null);
  now += FEED_STALL_MS - 1;
  assert.equal(noteFeedProgress(stats, now), null);
  now += 2;
  assert.equal(noteFeedProgress(stats, now), "recover");
  now += FEED_STALL_MS;
  assert.equal(noteFeedProgress(stats, now), "recover");
  now += FEED_STALL_MS;
  assert.equal(noteFeedProgress(stats, now), "end");
  assert.equal(stats.feedStalled, true);
  const healthy = { postsSeen: 3 };
  noteFeedProgress(healthy, 0);
  healthy.postsSeen = 4;
  assert.equal(noteFeedProgress(healthy, FEED_STALL_MS * 3), null, "a new post resets the clock");
});

test("few posts from a feed with loading trouble is infrastructure; a settled thin feed is not", () => {
  assert.equal(feedLoadTrouble({ shortColumnSeen: true }), true);
  assert.equal(feedLoadTrouble({ loadingPasses: 1 }), true);
  assert.equal(feedLoadTrouble({ feedStalled: true }), true);
  assert.equal(feedLoadTrouble({}), false);
});

// Analyst finding 1: thin-feed follows bypassed the follow cap and were not counted.

function followOptimizer({ followCap, dailyFollows = 0 } = {}) {
  const state = emptyState();
  state.enrolledAt = new Date(Date.now() - 30 * 86400_000).toISOString();
  beginRun(state, { testRun: false }, new Date(), () => {});
  Object.values(state.daily)[0].follows = dailyFollows;
  const optimizer = new Optimizer(state);
  optimizer.plan = { followCap, followRecommended: false, warmupMs: 0, windDownMs: 0, minMsBetweenFollows: 0, verify: true };
  return { state, optimizer };
}

function thinFollowPage(controls) {
  return {
    url: () => "https://www.linkedin.com/feed/",
    keyboard: { press: async () => {} },
    evaluate: async (_fn, _world, _helpers, method, args = []) => {
      if (method === "thinFeedFollowPlan") return { ready: controls, blocked: [] };
      if (method === "dialogOpen") return false;
      if (method === "thinFollowStatus") return "following";
      return null;
    },
  };
}

const ALESSANDRA = { name: "Alessandra Pellizzeri", kind: "person", url: "https://www.linkedin.com/in/alessandra-pellizzeri-5916b856/", x: 900, y: 390, hitLabel: "follow alessandra pellizzeri follow" };
const DONABEL = { name: "Donabel Santos", kind: "person", url: "https://www.linkedin.com/in/donabelsantos/", x: 840, y: 250, hitLabel: "follow donabel santos follow" };
const ADANI = { name: "Adani Group", kind: "company", url: "https://www.linkedin.com/company/adani-group/", x: 840, y: 320, hitLabel: "follow adani group follow" };

test("Mohammad Atiqullah: a plan with followCap 0 presses no thin-feed Follow", async () => {
  const { optimizer, state } = followOptimizer({ followCap: 0 });
  const presses = [];
  const stats = { postsSeen: 2, follows: 0, followAttempts: 0 };
  const result = await recoverThinFeedFollows(thinFollowPage([DONABEL, ALESSANDRA]), { clickAt: async (...args) => { presses.push(args); return true; } }, stats, {
    pause: quiet, waitMs: 0, followGate: thinFollowGate(optimizer, { started: 0 }),
  });
  assert.equal(presses.length, 0);
  assert.equal(stats.follows, 0);
  assert.equal(stats.followAttempts, 0);
  assert.equal(state.actions.length, 0);
  assert.deepEqual(result.followed, []);
});

test("thin-feed follows without a gate press nothing", async () => {
  const presses = [];
  await recoverThinFeedFollows(thinFollowPage([ALESSANDRA]), { clickAt: async (...args) => { presses.push(args); return true; } }, { postsSeen: 1 }, { pause: quiet, waitMs: 0 });
  assert.equal(presses.length, 0);
});

test("an approved thin-feed follow is reserved, finished, counted, people only, and stops at the cap", async () => {
  const { optimizer, state } = followOptimizer({ followCap: 1 });
  const presses = [];
  const stats = { postsSeen: 1, follows: 0, followAttempts: 0 };
  const denied = {};
  await recoverThinFeedFollows(thinFollowPage([ADANI, ALESSANDRA, DONABEL]), { clickAt: async (x, y, kind, url) => { presses.push(url); return true; } }, stats, {
    pause: quiet, waitMs: 0, followGate: thinFollowGate(optimizer, { started: 0, deniedReasons: denied }),
  });
  assert.deepEqual(presses, [ALESSANDRA.url], "company dropped, second person over the cap");
  assert.equal(stats.followAttempts, 1);
  assert.equal(stats.follows, 1);
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].kind, "follow");
  assert.equal(state.actions[0].status, "confirmed");
  assert.equal(Object.values(state.daily)[0].follows, 1);
  assert.ok(Object.keys(denied).some((reason) => /company|people only/i.test(reason)));
  assert.ok(Object.keys(denied).some((reason) => /cap/i.test(reason)));
});

test("the daily follow budget and per-person dedupe also block thin-feed follows", async () => {
  const { optimizer } = followOptimizer({ followCap: 2, dailyFollows: 3 });
  const presses = [];
  await recoverThinFeedFollows(thinFollowPage([ALESSANDRA]), { clickAt: async (...args) => { presses.push(args); return true; } }, { postsSeen: 1 }, {
    pause: quiet, waitMs: 0, followGate: thinFollowGate(optimizer, { started: 0 }),
  });
  assert.equal(presses.length, 0, "daily budget spent");

  const fresh = followOptimizer({ followCap: 2 });
  const gate = thinFollowGate(fresh.optimizer, { started: 0 });
  assert.equal(gate.approve(ALESSANDRA, { followAttempts: 0 }).allow, true);
  assert.equal(gate.approve(ALESSANDRA, { followAttempts: 1 }).allow, false, "one try per profile URL");
});

// Analyst finding 5: an approved More expand that then could not be located.
test("the More control is located before the optimizer is asked for an expand approval", async () => {
  let asked = 0;
  const optimizer = { gateExpand: () => { asked += 1; return { allow: true, reason: "ok" }; } };
  const post = { urn: "KP-5_VngbsbQH8EUvUSVZRoNKmbzSqd_3TtTMjZmR4cFeedType_MAIN_FEED_RELEVANCE", hasMore: true };
  const missed = await approveExpand({}, optimizer, post, {}, { locate: async () => null });
  assert.equal(missed.allow, false);
  assert.equal(missed.located, false);
  assert.equal(asked, 0, "a locate miss does not consume an approval");
  const found = await approveExpand({}, optimizer, post, {}, { locate: async () => ({ x: 600, y: 300 }) });
  assert.equal(found.allow, true);
  assert.equal(asked, 1);
});

// Analyst finding 3: Prakash Kharwar's GoLogin 403 said to inspect before releasing the lock,
// but no browser had started and the lock was released.
test("a GoLogin 403 on start says no browser started, does not retain the lock, and is infrastructure", async () => {
  const launcher = new LocalProfileLauncher({
    token: "fixture-token",
    fetchImpl: async () => new Response("proxies.checkErrorGroups.failsInUserEnv", { status: 403 }),
  });
  await assert.rejects(() => launcher.start("6aa76e946a90e78b1552372f"), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /No browser was started, so the browser lock is safe to release/);
    assert.doesNotMatch(error.message, /Inspect this profile/);
    assert.equal(error.retainBrowserLock, false);
    assert.notEqual(error.browserLaunched, true);
    assert.equal(failureKind(error), "infra");
    return true;
  });
});

test("a start that GoLogin accepted is marked as a launched browser even when it fails later", async () => {
  const { launcher } = emptyWsLauncher();
  launcher.discoverDebuggerUrl = async () => null;
  await assert.rejects(() => launcher.start("fixture"), (error) => error.browserLaunched === true);
});

// Analyst finding 4: Badal Umarwal 16:29-16:30Z. The first debugger listing was null, so the
// start-tab redirect never ran; then 40 working-tab polls saw iphey x17 and chrome-error x23.
test("Badal replay: a first null listing keeps polling and the iphey start tab is sent to the feed", async () => {
  let listing = 0;
  let tabUrl = "https://iphey.com/";
  const navigations = [];
  let now = 0;
  const launcher = new LocalProfileLauncher({
    token: "fixture-token",
    now: () => now,
    pause: async (ms) => { now += ms; },
    fetchImpl: async (url) => (String(url).includes("start-profile")
      ? Response.json({ status: "success", wsUrl: "ws://127.0.0.1:9/devtools/browser/fixture" })
      : new Response(null, { status: 204 })),
    listTargets: async () => {
      listing += 1;
      if (listing === 1) return null;
      if (listing === 2) return [];
      return [{ id: "start", url: tabUrl, webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/start" }];
    },
    navigateTarget: async (_target, feed) => { navigations.push(feed); tabUrl = feed; },
  });
  await launcher.start("6ab4f8406a7806f6d2ce0e56");
  assert.ok(listing >= 3, "polling continued after the first null listing");
  assert.deepEqual(navigations, ["https://www.linkedin.com/feed/"]);
});

test("Badal replay: getWorkingPage sends iphey to the feed; a proxy that turns it into chrome-error fails as infrastructure in two loads", async () => {
  const events = [];
  let polls = 0;
  const start = tab("https://iphey.com/", events);
  start.goto = async function goto(target) { events.push(["goto", this.href, target]); this.href = "chrome-error://chromewebdata/"; };
  const browser = { pages: async () => ((polls += 1) <= 2 ? [] : [start]) };
  await assert.rejects(() => getWorkingPage(browser, { pause: quiet }), (error) => {
    assert.equal(failureKind(error), "infra");
    return true;
  });
  const gotos = events.filter(([kind]) => kind === "goto");
  assert.deepEqual(gotos[0], ["goto", "https://iphey.com/", "https://www.linkedin.com/feed/"]);
  assert.equal(gotos.length, START_TAB_LINKEDIN_LOADS);
  assert.equal(events.filter(([kind]) => kind === "front").length, 0, "iphey and chrome-error never got input");

  const recovered = [];
  let reloads = 0;
  const flaky = tab("https://iphey.com/", recovered);
  flaky.goto = async function goto(target) { reloads += 1; this.href = reloads === 1 ? "chrome-error://chromewebdata/" : target; };
  const page = await getWorkingPage({ pages: async () => [flaky] }, { pause: quiet });
  assert.equal(page, flaky);
  assert.equal(reloads, 2, "chrome-error after the first load gets the second load");
});

// Monitor item 1: the whole session (feed + Grow + linger) fits the sampled 5-10 minutes.
const { planSessionBudget, LINGER_RESERVE_MS, BUDGET_SLACK_MS, LINGER_FLOOR_MS } = await import("../src/sessionBudget.js");

test("the planned feed + Grow + linger split fits the sampled window at both extremes", () => {
  const short = planSessionBudget({ sessionMs: 5 * 60_000, inviteCount: 7, order: ["feed", "grow"] });
  assert.equal(short.feedMs + short.growMs, 5 * 60_000);
  assert.ok(short.inviteCount >= 1 && short.inviteCount < 7, "a 5-minute session sends fewer than 7 invites");
  assert.ok(short.feedMs >= 150_000, "the feed keeps at least half the session");
  const long = planSessionBudget({ sessionMs: 10 * 60_000, inviteCount: 1, order: ["feed", "grow"] });
  assert.equal(long.feedMs + long.growMs, 10 * 60_000);
  assert.equal(long.inviteCount, 1);
  assert.ok(long.growMs <= 2 * 60_000);
  const feedOnly = planSessionBudget({ sessionMs: 7 * 60_000, inviteCount: 0, order: ["feed"] });
  assert.equal(feedOnly.feedMs, 7 * 60_000);
  assert.equal(feedOnly.growMs, 0);
});

test("the optimizer plans the budget: Grow is reserved from the same total and invites are trimmed", async () => {
  const { sampleSessionPlan } = await import("../src/config.js");
  for (let i = 0; i < 40; i += 1) {
    const state = emptyState();
    const optimizer = new Optimizer(state);
    const { plan } = optimizer.preflight();
    assert.equal(plan.feedMs + plan.growMs, plan.sessionMs);
    if (plan.order.includes("grow")) assert.ok(plan.inviteCount >= 1 && plan.growMs > 0);
    else assert.equal(plan.growMs, 0);
  }
  assert.ok(sampleSessionPlan().sessionMs > 0);
});

async function runBudgeted({ sessionMs, inviteCount, feedOverrunMs = 20_000 }) {
  const start = Date.now();
  let now = start;
  const clock = () => now;
  const budget = planSessionBudget({ sessionMs, inviteCount, order: ["feed", "grow"] });
  const plan = { sessionMs, order: ["feed", "grow"], inviteCount: budget.inviteCount, feedMs: budget.feedMs, growMs: budget.growMs };
  const seen = {};
  await runPlannedSteps({}, {}, plan, null, {
    clock,
    frameWait: quiet,
    steps: {
      feed: async (_page, feedPlan) => { seen.feedMs = feedPlan.sessionMs; now += feedPlan.sessionMs + feedOverrunMs; return { likes: 0, postsSeen: 30, expanded: 3, aborted: false }; },
      grow: async (_page, _state, options) => {
        seen.growMs = options.maxDurationMs;
        seen.invites = options.maxAttempts;
        now += options.maxDurationMs;
        return { connections: 1, attempted: 1, sent: [{ name: "A", url: "https://www.linkedin.com/in/a", confirmed: true }] };
      },
      dwell: async (_page, ms) => { seen.dwellMs = ms; now += ms; },
    },
  });
  return { elapsed: now - start, seen, budget };
}

test("enforced time stays inside the window: 5 minutes with 7 invites, 10 minutes with 1 invite", async () => {
  for (const [sessionMs, inviteCount] of [[5 * 60_000, 7], [10 * 60_000, 1]]) {
    const { elapsed, seen, budget } = await runBudgeted({ sessionMs, inviteCount });
    assert.equal(seen.feedMs, budget.feedMs, "the feed gets only its share");
    assert.equal(seen.invites, budget.inviteCount);
    assert.ok(seen.dwellMs >= LINGER_FLOOR_MS, "the linger never drops below its floor");
    assert.ok(elapsed <= sessionMs + BUDGET_SLACK_MS, `${sessionMs / 60_000} min session took ${Math.round(elapsed / 1000)}s`);
  }
});

test("Grow is skipped when the feed left no room, and the linger is bounded by what is left", async () => {
  const { elapsed, seen } = await runBudgeted({ sessionMs: 5 * 60_000, inviteCount: 1, feedOverrunMs: 4 * 60_000 });
  assert.equal(seen.growMs, undefined, "no Grow step without room for an invite");
  assert.equal(seen.dwellMs, undefined);
  assert.ok(elapsed > 5 * 60_000, "only the overrunning feed itself exceeded the budget");
  const tight = await runBudgeted({ sessionMs: 6 * 60_000, inviteCount: 2, feedOverrunMs: 60_000 });
  assert.ok(tight.seen.growMs <= 6 * 60_000 - tight.budget.feedMs - 60_000 - LINGER_RESERVE_MS + 1);
});

// Monitor item 3: restored tabs and new tabs.
const { markRestoredTabs, isRestoredTab, guardNewTabs, resolveLiveLinkedInPage } = await import("../src/browser/page.js");
const { leftMyNetwork } = await import("../src/scenario/linkedinNetwork.js");

test("Kamlesh: a restored Grow tab beside the feed is never picked, adopted, or given input", async () => {
  const events = [];
  const restored = tab("https://www.linkedin.com/mynetwork/grow/", events);
  restored.evaluate = async () => { throw new Error("restored tab touched"); };
  const feed = tab("https://www.linkedin.com/feed/", events);
  const browser = { pages: async () => [restored, feed] };
  const page = await getWorkingPage(browser, { pause: quiet });
  assert.equal(page, feed);
  assert.equal(isRestoredTab(restored), true);
  assert.deepEqual(events, [["front", "https://www.linkedin.com/feed/"]], "only the feed tab was foregrounded");
  assert.equal(await resolveLiveLinkedInPage({ pages: async () => [restored] }), null, "frame recovery never adopts it");

  const detached = { url: () => { throw new Error("Attempted to use detached Frame 'X'."); }, browser: () => ({ pages: async () => [restored] }) };
  const left = await leftMyNetwork(detached, { currentRun: null });
  assert.notEqual(left.action, "continue", "Grow never continues on the restored tab");
  assert.notEqual(left.page, restored);
});

test("a tab our own input opens is closed; tabs that were not opened by a page are left alone", async () => {
  const handlers = {};
  const browser = { on: (name, fn) => { handlers[name] = fn; }, off: () => {} };
  guardNewTabs(browser);
  let closed = 0;
  await handlers.targetcreated({ type: () => "page", opener: () => ({}), url: () => "https://www.linkedin.com/in/x/", page: async () => ({ close: async () => { closed += 1; } }) });
  await handlers.targetcreated({ type: () => "page", opener: () => null, url: () => "https://www.linkedin.com/feed/", page: async () => ({ close: async () => { closed += 1; } }) });
  await handlers.targetcreated({ type: () => "service_worker", opener: () => ({}), page: async () => ({ close: async () => { closed += 1; } }) });
  assert.equal(closed, 1);
});

// Monitor item 4: the muted feed video is never unmuted.
test("a feed video is watched in place without pressing its Unmute control", async () => {
  const { watchFeedVideo } = await import("../src/scenario/linkedinFeed.js");
  let clicks = 0;
  const human = {
    pointer: { x: 400, y: 300 },
    moveTo: async () => {},
    driftTo: async () => { throw new Error("watching in place"); },
    clickAt: async () => { clicks += 1; return true; },
  };
  const page = { evaluate: async () => { throw new Error("no DOM reads or presses before watching"); } };
  await assert.rejects(
    () => watchFeedVideo(page, human, { urn: "v1FeedType_MAIN_FEED_RELEVANCE", midX: 480, midY: 400, top: 200, hasMute: true, muteLabel: "Unmute" }, { onHeartbeat: () => {} }),
    /watching in place/,
  );
  assert.equal(clicks, 0, "the Unmute control was never pressed");
});

// Monitor finding: Gajendra Jat 18:25Z. Start tab linkedin.com/hp, then every URL was
// /login/?session_redirect=...feed, three detached-frame retries on frame 1ED430B3..., booked
// as infra and queued for retry. A logged-out account must pause as login instead.
const GAJENDRA_FRAME = "Attempted to use detached Frame '1ED430B321368BD00DECAFDD6560A8FF'.";
const GAJENDRA_LOGIN = "https://www.linkedin.com/login/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F";
const { accountBlockFromUrl, observedAccountBlock, pauseForAccount } = await import("../src/scenario/accountGuard.js");

function gajendraBrowser() {
  const page = {
    url: () => GAJENDRA_LOGIN,
    evaluate: async () => { throw new Error(GAJENDRA_FRAME); },
  };
  const browser = {
    pages: async () => [page],
    targets: () => [{ type: () => "page", url: () => GAJENDRA_LOGIN }],
  };
  page.browser = () => browser;
  return { page, browser };
}

test("the logged-out /hp home and the login redirect are login walls by URL alone", () => {
  assert.equal(accountBlockFromUrl("https://www.linkedin.com/hp")?.kind, "login");
  assert.equal(accountBlockFromUrl(GAJENDRA_LOGIN)?.kind, "login");
  assert.equal(accountBlockFromUrl("https://www.linkedin.com/feed/"), null);
  assert.equal(accountBlockFromUrl("https://www.linkedin.com/checkpoint/challenge/abc")?.kind, "challenge");
  assert.equal(accountBlockFromUrl("chrome-error://chromewebdata/"), null);
});

test("a login wall is found from target listings even when the page frame is detached", async () => {
  const browser = { pages: async () => [], targets: () => [{ type: () => "page", url: () => GAJENDRA_LOGIN }, { type: () => "service_worker", url: () => "https://www.linkedin.com/sw.js" }] };
  const page = { url: () => { throw new Error(GAJENDRA_FRAME); } };
  const block = await observedAccountBlock(browser, page);
  assert.equal(block.kind, "login");
  assert.equal(block.url, GAJENDRA_LOGIN);
});

test("Gajendra replay: detached frames on a login redirect end in a login pause, not infra or a retry", async () => {
  const { page } = gajendraBrowser();
  let feedCalls = 0;
  const result = await runPlannedSteps(page, {}, { order: ["feed", "grow"], inviteCount: 2 }, null, {
    frameWait: quiet,
    steps: {
      feed: async () => { feedCalls += 1; throw new Error(GAJENDRA_FRAME); },
      grow: async () => { throw new Error("Grow must not run on a logged-out account"); },
    },
  });
  assert.equal(feedCalls, 1, "the detached frame is not re-polled");
  assert.equal(result.aborted, true);
  assert.equal(result.accountBlock?.kind, "login");
  assert.notEqual(result.failureKind, "infra");
  assert.equal(sessionFailureKind(result), "account", "the batch sees an account stop and does not queue a retry");
  const state = emptyState();
  pauseForAccount(state, result.accountBlock);
  assert.equal(state.pause.kind, "login");
  assert.equal(state.pause.cooldownUntil, null);
});

test("Gajendra replay: a feed that opens on linkedin.com/hp pauses as login without navigating", async () => {
  const { runLinkedInFeed } = await import("../src/scenario/linkedinFeed.js");
  const navigations = [];
  const page = {
    url: () => "https://www.linkedin.com/hp",
    on: () => {},
    goto: async (url) => { navigations.push(url); },
    screenshot: async () => { throw new Error("no screenshot in tests"); },
    evaluate: async () => { throw new Error(GAJENDRA_FRAME); },
  };
  const result = await runLinkedInFeed(page, { sessionMs: 60_000, likeRate: 0.03, expandRate: 0.3, reverseScrollChance: 0.05 }, { plan: { followCap: 0 } }, {});
  assert.deepEqual(navigations, [], "the logged-out home is never navigated to /feed/");
  assert.equal(result.aborted, true);
  assert.equal(result.accountBlock?.kind, "login");
  assert.notEqual(result.failureKind, "infra");
});

test("Gajendra replay: an inspect that fails on a detached frame falls back to the browser's URLs", async () => {
  const { runLinkedInFeed } = await import("../src/scenario/linkedinFeed.js");
  let url = "https://www.linkedin.com/feed/";
  const browser = { pages: async () => [], targets: () => [{ type: () => "page", url: () => GAJENDRA_LOGIN }] };
  const page = {
    url: () => url,
    on: () => {},
    browser: () => browser,
    screenshot: async () => { throw new Error("no screenshot in tests"); },
    evaluate: async () => { throw new Error(GAJENDRA_FRAME); },
  };
  const result = await runLinkedInFeed(page, { sessionMs: 60_000, likeRate: 0.03, expandRate: 0.3, reverseScrollChance: 0.05 }, { plan: { followCap: 0 } }, {});
  assert.equal(result.accountBlock?.kind, "login");
  assert.equal(result.aborted, true);
});

// End-of-batch verifier findings.
const { accountWallGuard, sessionMinutes } = await import("../src/runner.js");
const { detectBlock } = await import("../src/scenario/linkedinFeed.js");
const { POINTER_SLOW_MOVE_GAP_MS } = await import("../src/human/trackpad.js");

test("Mohit: the session-closed log reports planned, budgeted, and total minutes separately", () => {
  const minutes = sessionMinutes({ sessionMs: 5.6 * 60_000 }, { budgetedMs: 5.9 * 60_000, durationMs: 6.4 * 60_000 });
  assert.deepEqual(minutes, { plannedMin: 5.6, budgetedMin: 5.9, totalMin: 6.4 });
});

test("runPlannedSteps reports the budgeted time measured from the first feed action", async () => {
  const { elapsed } = await runBudgeted({ sessionMs: 5.6 * 60_000, inviteCount: 1 });
  const start = Date.now();
  let now = start;
  const result = await runPlannedSteps({}, {}, { sessionMs: 300_000, order: ["feed"], feedMs: 300_000 }, null, {
    clock: () => now, frameWait: quiet,
    steps: { feed: async () => { now += 305_000; return { likes: 0, postsSeen: 20, aborted: false }; } },
  });
  assert.equal(result.budgetedMs, 305_000);
  assert.ok(elapsed <= 5.6 * 60_000 + BUDGET_SLACK_MS);
});

test("Prakash retry: one slow account inspect is retried once before it is infrastructure", async () => {
  const timeout = () => new Error("Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.");
  const page = { url: () => "https://www.linkedin.com/feed/", browser: () => ({ pages: async () => [], targets: () => [] }) };
  let calls = 0;
  const ok = await detectBlock(page, { inspect: async () => { if ((calls += 1) === 1) throw timeout(); return null; } });
  assert.deepEqual(ok, { blocked: false });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(() => detectBlock(page, { inspect: async () => { calls += 1; throw timeout(); } }), /timed out/);
  assert.equal(calls, 2, "retried once, not forever");
  const walled = { url: () => GAJENDRA_LOGIN, browser: () => ({ pages: async () => [], targets: () => [] }) };
  const block = await detectBlock(walled, { inspect: async () => { throw timeout(); } });
  assert.equal(block.blocked, true);
  assert.equal(block.kind, "login", "a slow page still reports the wall from its URL");
});

test("no aborted result becomes infra while a login or checkpoint is visible in any tab", async () => {
  const walledBrowser = { pages: async () => [], targets: () => [{ type: () => "page", url: () => "https://www.linkedin.com/checkpoint/challenge/AgFiK8lxh_MS3w" }] };
  for (const reason of ["Feed stayed on a loading screen", "Feed frame detached before any posts were read after 3 navigation attempts.", "Feed stopped loading new posts after 2 unique posts", "Too few distinct posts to verify useful feed browsing"]) {
    const result = await accountWallGuard({ aborted: true, failureKind: "infra", reason }, walledBrowser);
    assert.equal(result.accountBlock?.kind, "challenge", reason);
    assert.notEqual(result.failureKind, "infra", reason);
    assert.equal(sessionFailureKind(result), "account", reason);
  }
  const loggedOut = await accountWallGuard({ aborted: true, failureKind: "infra" }, { pages: async () => [], targets: () => [{ type: () => "page", url: () => "https://www.linkedin.com/hp" }] });
  assert.equal(loggedOut.accountBlock?.kind, "login");
  const operator = await accountWallGuard({ aborted: true, failureKind: "operator" }, walledBrowser);
  assert.equal(operator.accountBlock, undefined, "an operator stop is left as is");
  const healthy = await accountWallGuard({ aborted: true, failureKind: "infra" }, { pages: async () => [], targets: () => [{ type: () => "page", url: () => "https://www.linkedin.com/feed/" }] });
  assert.equal(healthy.failureKind, "infra", "a real infrastructure failure stays infra");
  const done = await accountWallGuard({ aborted: false }, walledBrowser);
  assert.equal(done.accountBlock, undefined);
});

test("Mohit/Gunjan: after a pointer stall the cadence slows; moves are not re-sent and rapid moves are skipped", async () => {
  let now = 1_000_000;
  let sends = 0;
  let stall = true;
  const page = {
    bringToFront: async () => {},
    createCDPSession: async () => ({
      send: () => { sends += 1; if (stall) { stall = false; return new Promise(() => {}); } return Promise.resolve(); },
      detach: async () => {},
    }),
  };
  const pointer = new TrustedPointer(page, { commandTimeoutMs: 15, now: () => now });
  await pointer.move(100, 100);
  assert.equal(pointer.slowed(), true, "one stall enters slow mode");
  assert.equal(sends, 2, "the stalled move was retried once before slow mode began");
  const before = sends;
  for (let i = 0; i < 10; i += 1) { await pointer.move(100 + i, 100); now += 10; }
  assert.ok(sends - before <= 2, `only moves ${POINTER_SLOW_MOVE_GAP_MS}ms apart are sent (${sends - before} of 10)`);
  assert.equal(pointer.x, 109, "coordinates still track skipped moves");
  now += 61_000;
  assert.equal(pointer.slowed(), false, "slow mode ends");
});
