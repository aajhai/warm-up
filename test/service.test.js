import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const root = mkdtempSync(join(tmpdir(), "warmup-test-"));
process.env.WARMUP_DATA_DIR = root;
process.env.GL_PROFILE_NAME = "Fixture";
process.env.GL_PROFILE_ID = "fixture";
process.env.CONNECTIONS_ENABLED = "true";
const { emptyState, loadState, saveState, scopedStatePath, getDayStats } = await import("../src/sessionState.js");
const { config } = await import("../src/config.js");
const { utcWeekKey, weeklyBudget, reserveAction, finishAction, beginRun, recoverInterruptedRun } = await import("../src/activity.js");
const { nextRunAt, claimWindow } = await import("../src/scheduler.js");
const { SlackNotifier, redact } = await import("../src/notifications/slack.js");
const { acquireLock, unlockStoppedProcess } = await import("../src/lock.js");
const { classifyAccount } = await import("../src/scenario/accountGuard.js");
const { networkDomWorld, runConnectionBatch } = await import("../src/scenario/linkedinNetwork.js");
const { feedDomWorld, feedDomHelpers } = await import("../src/scenario/linkedinDom.js");
const { Optimizer } = await import("../src/optimizer/reviewer.js");
const { scrollDistance, HumanController, controlNeedsFeedClamp } = await import("../src/human/input.js");
const { TrustedPointer } = await import("../src/human/trackpad.js");
const { getWorkingPage } = await import("../src/scenario/linkedinFeed.js");
const { LocalProfileLauncher } = await import("../src/gologin/local.js");
const { CloudProfileLauncher } = await import("../src/gologin/cloud.js");
const { planProfiles } = await import("../src/service.js");
const { recordCancellation } = await import("../src/util/cancellation.js");
const { foregroundPage } = await import("../src/browser/page.js");
const { istNow } = await import("../src/util/time.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("UTC connection week switches exactly at Monday midnight, including year rollover", () => {
  assert.equal(utcWeekKey(new Date("2026-09-20T23:59:59.999Z")), "2026-09-14");
  assert.equal(utcWeekKey(new Date("2026-09-21T00:00:00.000Z")), "2026-09-21");
  assert.equal(utcWeekKey(new Date("2027-01-01T00:00:00Z")), "2026-12-28");
});

test("weekly budget is sampled once; partial enrollment does not immediately advance the stage", () => {
  const state = emptyState();
  state.enrolledAt = "2026-09-16T12:00:00Z";
  assert.equal(weeklyBudget(state, new Date("2026-09-16T12:00:00Z"), () => 44).cap, 44);
  assert.equal(weeklyBudget(state, new Date("2026-09-20T23:00:00Z"), () => { throw new Error("resampled"); }).cap, 44);
  const partial = weeklyBudget(state, new Date("2026-09-21T00:00:00Z"), (min) => min);
  assert.equal(partial.stage, 1);
  const second = weeklyBudget(state, new Date("2026-09-28T00:00:00Z"), (min) => min);
  assert.equal(second.stage, 2);
  assert.equal(second.cap, 50);
  const mature = weeklyBudget(state, new Date("2027-01-04T00:00:00Z"), (_, max) => max);
  assert.equal(mature.cap, 100);
});

test("connection reservations survive restart, prevent duplicates, and consume uncertain outcomes", () => {
  const now = new Date("2026-09-14T06:00:00Z");
  const state = emptyState();
  beginRun(state, { testRun: false }, now);
  weeklyBudget(state, now, () => 30);
  const id = reserveAction(state, "connect", "https://www.linkedin.com/in/one", { now, limit: 4 });
  assert.ok(id);
  let restarted = loadState();
  assert.equal(restarted.weekly["2026-09-14"].used, 1);
  assert.equal(reserveAction(restarted, "connect", "https://www.linkedin.com/in/one", { now, limit: 4 }), null);
  finishAction(restarted, id, false);
  recoverInterruptedRun(restarted);
  restarted = loadState();
  assert.equal(restarted.weekly["2026-09-14"].used, 1);
  assert.equal(restarted.actions[0].status, "unconfirmed");
  assert.equal(restarted.pause.kind, "uncertain_connection");
  assert.equal(restarted.currentRun, null);
  assert.equal(restarted.daily["2026-09-14"].aborted, 1);
});

test("weekly and daily budgets, batch limits, paused profiles and test mode cannot be bypassed", () => {
  const now = new Date("2026-09-14T06:00:00Z");
  const state = emptyState();
  const persist = () => {};
  beginRun(state, { testRun: false }, now, persist);
  weeklyBudget(state, now, () => 30);
  for (let i = 0; i < 4; i += 1) assert.ok(reserveAction(state, "connect", `person-${i}`, { now, persist, limit: 4 }));
  assert.equal(reserveAction(state, "connect", "person-5", { now, persist, limit: 4 }), null);
  state.currentRun.id = "next-run";
  assert.ok(reserveAction(state, "connect", "person-6", { now, persist, limit: 4 }));
  assert.equal(reserveAction(state, "connect", "person-7", { now, persist, limit: 4 }), null);
  state.daily["2026-09-14"].connections = 0;
  state.weekly["2026-09-14"].used = 30;
  assert.equal(reserveAction(state, "connect", "person-8", { now, persist, limit: 4 }), null);
  state.currentRun.testRun = true;
  assert.throws(() => reserveAction(state, "connect", "person-9", { now, persist, limit: 4 }), /production run/);
  state.currentRun.testRun = false;
  state.pause = { reason: "challenge" };
  assert.throws(() => reserveAction(state, "like", "post-1", { now, persist, limit: 3 }), /production run/);
});

test("a crash during a connection attempt pauses the profile; test runs do not start warm-up age", () => {
  const now = new Date("2026-09-14T06:00:00Z");
  const state = emptyState();
  beginRun(state, { testRun: true }, now, () => {});
  assert.equal(state.enrolledAt, undefined);
  recoverInterruptedRun(state, () => {});
  beginRun(state, { testRun: false }, now, () => {});
  reserveAction(state, "connect", "person", { now, limit: 4, persist: () => {} });
  recoverInterruptedRun(state, () => {});
  assert.equal(state.pause.kind, "uncertain_connection");
});

test("state is profile-scoped and corrupt state fails closed", () => {
  const a = { profileId: "a", profileName: "A" };
  const b = { profileId: "b", profileName: "B" };
  const state = emptyState(a);
  state.pause = { reason: "review required" };
  saveState(state, a);
  assert.equal(loadState(a).pause.reason, "review required");
  assert.equal(loadState(b).pause, null);
  writeFileSync(scopedStatePath(b), "{broken");
  assert.throws(() => loadState(b), /Refusing to reset/);
  assert.throws(() => scopedStatePath({ profileId: "../../elsewhere" }), /valid profile/);
  const invalid = emptyState(b);
  invalid.weekly["2026-09-14"] = { cap: 50, used: -1, confirmed: 0 };
  saveState(invalid, b);
  assert.throws(() => loadState(b), /Invalid weekly/);
  writeFileSync(scopedStatePath(b), JSON.stringify({ schemaVersion: 2 }));
  assert.throws(() => loadState(b), /Incomplete profile/);
});

test("scheduler persists chosen windows, claims once, and skips missed windows after sleep", () => {
  const state = emptyState();
  const before = new Date("2026-09-14T03:00:00Z");
  const next = nextRunAt(state, before, () => 0.5);
  const same = nextRunAt(state, before, () => { throw new Error("resampled"); });
  assert.equal(same.at.getTime(), next.at.getTime());
  assert.equal(claimWindow(state, next.key, before), false);
  assert.equal(claimWindow(state, next.key, next.at), true);
  assert.equal(claimWindow(state, next.key, next.at), false);
  const later = nextRunAt(state, next.at, () => 0.5);
  assert.notEqual(later.key, next.key);
  const wake = new Date(later.at.getTime() + 5 * 60_000);
  const afterSleep = nextRunAt(state, wake, () => 0.5);
  assert.equal(state.windows[later.key].status, "missed");
  assert.notEqual(afterSleep.key, later.key);
  state.pause = { reason: "challenge" };
  assert.equal(nextRunAt(state, wake), null);
});

test("live process locks exclude another runner and cannot be unlocked", () => {
  const directory = join(root, "locks");
  const release = acquireLock("browser", directory);
  assert.throws(() => acquireLock("browser", directory), /holds/);
  assert.throws(() => unlockStoppedProcess("browser", directory), /still running/);
  release();
  acquireLock("browser", directory)();
});

test("Slack outbox retries 429 after Retry-After, survives restart, and never stores credentials", async () => {
  const directory = join(root, "slack");
  const webhook = "https://hooks.slack.com/services/test/redacted/token";
  let now = 100_000;
  let calls = 0;
  const fakeFetch = async (_, options) => {
    calls += 1;
    assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).mrkdwn, false);
    return new Response("rate_limited", { status: 429, headers: { "retry-after": "120" } });
  };
  const notifier = new SlackNotifier({ directory, webhook: () => webhook, now: () => now, fetchImpl: fakeFetch });
  notifier.enqueue({ type: "test", message: `Failure at ${webhook}` });
  assert.equal((await notifier.flush()).pending, 1);
  assert.equal(calls, 1);
  assert.ok(!readFileSync(join(directory, readdirSync(directory)[0]), "utf8").includes(webhook));
  now += 119_999;
  await notifier.flush();
  assert.equal(calls, 1);
  now += 1;
  const restarted = new SlackNotifier({ directory, webhook: () => webhook, now: () => now, fetchImpl: async () => new Response("ok") });
  assert.equal((await restarted.flush()).sent, 1);
  assert.equal(readdirSync(directory).length, 0);
  assert.equal(redact(webhook), "[Slack webhook]");
});

test("Slack scans past backed-off events so newer due alerts can be delivered", async () => {
  const directory = join(root, "slack-backlog");
  let now = 100_000;
  const notifier = new SlackNotifier({ directory, now: () => now, webhook: () => "https://hooks.slack.com/services/test/redacted/token", fetchImpl: async () => new Response("ok") });
  for (let i = 0; i < 11; i += 1) {
    notifier.enqueue({ type: "old", message: "old" });
    now += 1;
  }
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const event = JSON.parse(readFileSync(path));
    event.nextAttemptAt = now + 3600_000;
    writeFileSync(path, JSON.stringify(event));
  }
  notifier.enqueue({ type: "new", message: "new" });
  const result = await notifier.flush();
  assert.equal(result.sent, 1);
  assert.equal(result.pending, 11);
});

test("account guard distinguishes login, challenge, invitation limit and spoofed domains", () => {
  assert.equal(classifyAccount("https://www.linkedin.com/login").kind, "login");
  assert.equal(classifyAccount("https://www.linkedin.com/checkpoint/challenge").kind, "challenge");
  assert.equal(classifyAccount("https://www.linkedin.com/mynetwork/", "You've reached your weekly invitation limit").kind, "invitation_limit");
  assert.equal(classifyAccount("https://linkedin.com.attacker.invalid/feed/").kind, "unexpected_page");
  assert.equal(classifyAccount("https://www.linkedin.com/feed/", "Welcome back", true), null);
});

function domWorld(html) {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll("*")) {
    el.getBoundingClientRect = () => ({ x: 300, y: 150, top: 150, bottom: 190, width: 120, height: 40 });
  }
  return { document, world: vm.runInNewContext(`(${networkDomWorld.toString()})()`, { document, location: { origin: "https://www.linkedin.com" }, innerHeight: 900, getComputedStyle: () => ({ visibility: "visible" }), URL }) };
}

test("My Network selects only person-linked Connect cards, verifies target, and recognizes Pending", () => {
  const { document, world } = domWorld('<main><ul><li><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li><li><a href="https://www.linkedin.com/company/acme">Acme</a><button>Connect</button></li><li><a href="https://www.linkedin.com/in/ben">Ben Example</a><button>Follow</button></li><li><button>Connect</button></li></ul></main>');
  const candidates = world.inspect();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://www.linkedin.com/in/amy");
  const button = document.querySelector("li button");
  document.elementFromPoint = () => button;
  assert.equal(world.probe({ url: candidates[0].url, x: 310, y: 160 }), true);
  assert.equal(world.probe({ url: "https://www.linkedin.com/in/ben", x: 310, y: 160 }), false);
  button.textContent = "Pending";
  assert.equal(world.pending({ url: candidates[0].url }), true);
  assert.equal(world.inspect().length, 0);
});

test("connection dialogs require the right recipient and a specific send-without-note button", () => {
  const { world } = domWorld('<main></main><div role="dialog">Invite Amy Example<button>Send without a note</button><button>Add a note</button></div>');
  assert.equal(world.dialog({ name: "Amy Example" }).safe, true);
  assert.equal(world.dialog({ name: "Ben Example" }).safe, false);
  const email = domWorld('<main></main><div role="dialog">Amy Example<input type="email"><button>Send without a note</button></div>');
  assert.equal(email.world.dialog({ name: "Amy Example" }).safe, false);
  const unknown = domWorld('<main></main><div role="dialog">Amy Example<button>Send</button></div>');
  assert.equal(unknown.world.dialog({ name: "Amy Example" }).safe, false);
});

test("a connection trial confirms exactly one request and retains allowance when confirmation is absent", async () => {
  const previous = { ...config };
  try {
    config.forceOutsideHours = true;
    for (const confirms of [true, false]) {
      const { document, world } = domWorld('<main><li><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li></main>');
      const button = document.querySelector("button");
      document.elementFromPoint = () => button;
      let url = "https://www.linkedin.com/feed/";
      let clicks = 0;
      const state = emptyState();
      beginRun(state, { testRun: false, connectionTrial: true });
      const page = {
        url: () => url, goto: async (to) => { url = to; },
        evaluate: async (fn, ...args) => args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true },
        mouse: { move: async () => {}, click: async () => {
          // Reservation must already be on disk at the moment the click is dispatched.
          assert.equal(loadState().actions[0].status, "reserved");
          clicks += 1;
          if (confirms) button.textContent = "Pending";
        } },
      };
      const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: async () => {} });
      assert.equal(clicks, 1);
      assert.equal(result.attempted, 1);
      assert.equal(result.connections, confirms ? 1 : 0);
      assert.equal(result.accountBlock?.kind, confirms ? undefined : "uncertain_connection");
      assert.equal(loadState().actions[0].status, confirms ? "confirmed" : "unconfirmed");
      assert.equal(Object.values(loadState().weekly)[0].used, 1);
    }
  } finally { Object.assign(config, previous); }
});

test("connection trials consume production slots, allow no likes, and cannot combine with test mode", () => {
  const previous = { ...config };
  try {
    Object.assign(config, { connectionTrial: true, testRun: false, forceOutsideHours: true });
    const state = emptyState();
    const plan = new Optimizer(state).preflight().plan;
    assert.equal(plan.connectionTrial, true);
    assert.equal(plan.likeCap, 0);
    assert.ok(plan.sessionMs <= 4 * 60_000);
    const run = beginRun(state, plan, new Date(), () => {});
    assert.equal(run.testRun, false);
    assert.equal(state.daily[run.dayKey].sessions, 1);
    config.testRun = true;
    assert.equal(new Optimizer(emptyState()).preflight().allow, false);
  } finally { Object.assign(config, previous); }
});

test("operator can continue after two aborted production sessions", () => {
  const previous = { ...config };
  try {
    Object.assign(config, { allowBlockedDay: true, forceOutsideHours: true, testRun: false, connectionTrial: false });
    const state = emptyState();
    const day = getDayStats(state, istNow().dateKey);
    day.aborted = 2;
    day.sessions = 2;
    const preflight = new Optimizer(state).preflight();
    assert.equal(preflight.allow, true);
    assert.ok(preflight.plan.likeCap > 0);
  } finally { Object.assign(config, previous); }
});

test("forced test runs have zero likes even during work hours; prospective like rate includes the next action", () => {
  const previous = { ...config };
  try {
    config.testRun = true;
    config.forceOutsideHours = true;
    const optimizer = new Optimizer(emptyState());
    const preflight = optimizer.preflight();
    assert.equal(preflight.plan.likeCap, 0);
    optimizer.plan = { likeCap: 3, warmupMs: 0, windDownMs: 0, skipFirstPosts: 0, likeRate: 0.03 };
    assert.match(optimizer.gateLike({ post: { hasLike: true, textLen: 300 }, stats: { likes: 0, postsSeen: 20 }, elapsedMs: 1000, remainingMs: 1000 }).reason, /exceed/);
  } finally { Object.assign(config, previous); }
});

test("scroll displacement does not cancel window movement against the same post's screen movement", () => {
  assert.equal(scrollDistance({ top: 0, firstTop: 300, firstUrn: "a" }, { top: 200, firstTop: 100, firstUrn: "a" }), 200);
  assert.equal(scrollDistance({ top: 0, firstTop: 300, firstUrn: "a" }, { top: 0, firstTop: 100, firstUrn: "a" }), 200);
  assert.equal(scrollDistance({ top: 0, firstTop: 300, firstUrn: "a" }, { top: 0, firstTop: 300, firstUrn: "b" }), null);
});

test("lost dedicated pointer channel uses a short-lived CDP session, never page.mouse", async () => {
  const calls = [];
  const page = {
    mouse: {
      move: async () => { throw new Error("page.mouse.move"); },
      wheel: async () => { throw new Error("page.mouse.wheel"); },
      click: async () => { throw new Error("page.mouse.click"); },
    },
    bringToFront: async () => calls.push(["foreground"]),
    createCDPSession: async () => ({
      send: async (method, params) => { calls.push([method, params.type, params.deltaY]); },
      detach: async () => { calls.push(["detach"]); },
    }),
  };
  const pointer = new TrustedPointer(page);
  pointer.dead = true;
  await pointer.move(400, 300);
  await pointer.wheel(80);
  await pointer.click();
  assert.equal(calls.filter(([kind]) => kind === "Input.dispatchMouseEvent")[0][1], "mouseMoved");
  assert.equal(calls.find((call) => call[1] === "mouseWheel")[2], 80);
  assert.ok(calls.some((call) => call[1] === "mousePressed"));
  assert.ok(calls.some((call) => call[0] === "detach"));
});

test("a hung mouse CDP command is abandoned in a few seconds without using page.mouse", async () => {
  let detached = 0;
  const page = {
    mouse: {
      move: async () => { throw new Error("page.mouse.move"); },
      wheel: async () => { throw new Error("page.mouse.wheel"); },
    },
    bringToFront: async () => {},
    createCDPSession: async () => ({
      send: () => new Promise(() => {}),
      detach: async () => { detached += 1; },
    }),
  };
  const pointer = new TrustedPointer(page, { commandTimeoutMs: 40 });
  const started = Date.now();
  await assert.rejects(() => pointer.wheel(80), /timed out/);
  assert.ok(Date.now() - started < 1000);
  assert.ok(detached >= 1);
  assert.equal(pointer.dead, true);
});

test("cloud-sized viewports still count posts that the old 70px band rejected", async () => {
  const { readablePostBox, feedViewportHeight } = await import("../src/scenario/linkedinDom.js");
  assert.equal(feedViewportHeight(0, 0, 0), 900);
  assert.equal(feedViewportHeight(180, 1100), 1100);
  assert.equal(readablePostBox({ top: 589, height: 720, bottom: 1309 }, 600), true);
  assert.equal(readablePostBox({ top: 800, height: 400, bottom: 1200 }, 0), true);
  assert.equal(readablePostBox({ top: 50, height: 20, bottom: 70 }, 800), false);
});

test("like controls are not clamped to the old 680px hover ceiling", async () => {
  const { feedPointerBounds } = await import("../src/scenario/linkedinDom.js");
  const bounds = feedPointerBounds({ left: 300, width: 540 }, 1440, 900);
  assert.equal(controlNeedsFeedClamp("like"), false);
  assert.equal(controlNeedsFeedClamp("more"), false);
  assert.equal(controlNeedsFeedClamp("browse"), true);
  assert.ok(bounds.maxY > 680);
  assert.equal(bounds.maxY, 804);
});

test("See new posts is found in the lower viewport, not only the top 220px", async () => {
  const { seeNewPostsVisible } = await import("../src/scenario/linkedinDom.js");
  assert.equal(seeNewPostsVisible({ top: 40, height: 32, width: 140, bottom: 72 }, 900), true);
  assert.equal(seeNewPostsVisible({ top: 700, height: 36, width: 150, bottom: 736 }, 900), true);
  assert.equal(seeNewPostsVisible({ top: 920, height: 36, width: 150, bottom: 956 }, 900), false);
  assert.equal(seeNewPostsVisible({ top: 700, height: 8, width: 150, bottom: 708 }, 900), false);
});

test("media hits are not like targets, and likes sit in the lower third", async () => {
  const { isMediaHit, likeActionBand } = await import("../src/scenario/linkedinDom.js");
  const { document } = parseHTML(`<!doctype html><html><body>
    <a href="/feed/update/1"><img src="photo.jpg" alt="morning habits"></a>
    <div>
      <button aria-label="Reaction button state: no reaction Like">Like</button>
      <button>Comment</button>
    </div>
  </body></html>`);
  assert.equal(isMediaHit(document.querySelector("img")), true);
  assert.equal(isMediaHit(document.querySelector("a")), true);
  assert.equal(isMediaHit(document.querySelector("button")), false);
  const band = likeActionBand(900);
  assert.equal(band.minY, 558);
  assert.equal(band.maxY, 792);
});

test("revealControl scrolls a below-fold like button into the lower-third action band", async () => {
  const wheels = [];
  let y = 860;
  const human = new HumanController({ evaluate: async () => 900 });
  human.ensureOverFeed = async () => {};
  human.pointer = { wheel: async (delta) => { wheels.push(delta); y -= delta; } };
  const point = await human.revealControl("urn", "like", {
    locate: async () => ({ x: 480, y, label: "like" }),
  });
  assert.ok(wheels.length >= 1);
  assert.ok(wheels[0] > 150);
  assert.ok(point.y >= 558 && point.y <= 792);
});

test("fallback gestures use one movement and one wheel dispatch instead of many slow round trips", async () => {
  const moves = [];
  const wheels = [];
  const human = new HumanController({});
  human.pointer = { dead: true, x: 500, y: 300, move: async (...args) => moves.push(args), wheel: async (delta) => wheels.push(delta) };
  human.clampToFeed = async (x, y) => ({ x, y });
  await human.moveTo(550, 320);
  await human.driftTo(560, 330);
  assert.deepEqual(moves, [[550, 320], [560, 330]]);
  human.ensureOverFeed = async () => {};
  human.followContent = async () => {};
  human.scrollOffset = async () => ({ top: 0, firstUrn: "fixture", firstTop: 100 });
  await human.scrollFeed({ reverseChance: 0 });
  assert.equal(wheels.length, 1);
  assert.ok(wheels[0] > 250 && wheels[0] <= 720);
});

test("healthy scroll gestures keep the pointer stationary and wait for delayed movement", async () => {
  const calls = [];
  let reads = 0;
  const human = new HumanController({});
  human.pointer = {
    dead: false,
    x: 500,
    y: 300,
    coords: () => ({ x: 500, y: 300 }),
    move: async (...args) => calls.push(["move", ...args]),
    wheel: async (delta) => calls.push(["wheel", delta]),
  };
  human.ensureOverFeed = async () => {};
  human.followContent = async () => {};
  human.scrollOffset = async () => {
    reads += 1;
    return { top: reads < 4 ? 100 : 420, firstUrn: "fixture", firstTop: reads < 4 ? 200 : -120 };
  };
  const result = await human.scrollFeed({ reverseChance: 0 });
  assert.equal(calls.filter(([kind]) => kind === "wheel").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "move").length, 0);
  assert.equal(result.moved, 320);
  assert.ok(reads >= 4);
});

test("browser selection reuses and foregrounds the exact feed tab without creating a tab", async () => {
  let foregrounded = 0;
  const article = { url: () => "https://www.linkedin.com/feed/update/urn:li:activity:1/", bringToFront: async () => { throw new Error("Wrong tab"); } };
  const feed = { url: () => "https://www.linkedin.com/feed/", bringToFront: async () => { foregrounded += 1; }, createCDPSession: async () => ({ send: async (method) => method === "Target.getTargetInfo" ? { targetInfo: { targetId: "fixture" } } : { windowId: 1, bounds: { windowState: "normal" } }, detach: async () => {} }) };
  const page = await getWorkingPage({ pages: async () => [article, feed] });
  assert.equal(page, feed);
  assert.equal(foregrounded, 1);
});

test("local GoLogin starts synchronously, accepts only loopback CDP, and awaits stop", async () => {
  const calls = [];
  const launcher = new LocalProfileLauncher({ token: "fixture-token", fetchImpl: async (url, options) => {
    if (typeof url !== "string") throw new Error("closed", { cause: { code: "ECONNREFUSED" } });
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return url.endsWith("start-profile")
      ? Response.json({ status: "success", wsUrl: "ws://127.0.0.1:1234/devtools/browser/fixture" })
      : new Response(null, { status: 204 });
  } });
  assert.match(await launcher.start("fixture"), /^ws:\/\/127\.0\.0\.1/);
  await launcher.stop();
  assert.equal(launcher.profileId, null);
  assert.deepEqual(calls.map((c) => c.body), [{ profileId: "fixture", sync: true }, { profileId: "fixture" }]);
  assert.ok(calls.every((c) => c.url.startsWith("http://127.0.0.1:36912/") && c.redirect === "error"));
  for (const wsUrl of ["ws://attacker.invalid/devtools/browser/a", "https://127.0.0.1/devtools/browser/a", "ws://user:pass@127.0.0.1/devtools/browser/a", "ws://127.0.0.1/wrong", undefined]) {
    const invalid = new LocalProfileLauncher({ fetchImpl: async () => Response.json({ status: "success", wsUrl }) });
    await assert.rejects(invalid.start("fixture"), (e) => e.retainBrowserLock === true);
  }
});

test("cloud GoLogin uses the persistent profile endpoint and authenticated remote stop", async () => {
  const calls = [];
  const launcher = new CloudProfileLauncher({ token: "fixture-token", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    return new Response(null, { status: options.method === "DELETE" ? 204 : 200 });
  } });
  const wsUrl = await launcher.start("fixture_profile");
  assert.equal(wsUrl, "wss://cloudbrowser.gologin.com/connect?token=fixture-token&profile=fixture_profile");
  await launcher.stop();
  assert.equal(calls[0].url, "https://cloudbrowser.gologin.com/connect?token=fixture-token&profile=fixture_profile");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].url, "https://api.gologin.com/browser/fixture_profile/web");
  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].headers.Authorization, "Bearer fixture-token");
  assert.equal(launcher.profileId, null);
});

test("fullscreen Orbita is restored before foregrounding without changing window dimensions", async () => {
  const calls = [];
  const cdp = { send: async (method, args) => {
    calls.push([method, args]);
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "fixture" } };
    if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: { windowState: "fullscreen" } };
  }, detach: async () => calls.push(["detach"]) };
  await foregroundPage({ createCDPSession: async () => cdp, bringToFront: async () => calls.push(["foreground"]) });
  assert.deepEqual(calls[2], ["Browser.setWindowBounds", { windowId: 7, bounds: { windowState: "normal" } }]);
  assert.equal(calls[3][0], "foreground");
  assert.equal(calls[4][0], "detach");
});

test("an accepted Stop request retains the lock until the browser endpoint actually closes", async () => {
  let now = 0;
  const launcher = new LocalProfileLauncher({ now: () => now, pause: async (ms) => { now += ms; }, fetchImpl: async (url) => {
    if (typeof url === "string") return new Response(null, { status: 204 });
    return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/browser/fixture" });
  } });
  launcher.profileId = "fixture";
  launcher.wsUrl = "ws://127.0.0.1:1234/devtools/browser/fixture";
  await assert.rejects(launcher.stop(), (e) => e.retainBrowserLock && /remained open/.test(e.message));
  assert.equal(launcher.profileId, "fixture");
});

test("ambiguous GoLogin launch and failed shutdown retain the browser lock without retrying", async () => {
  let calls = 0;
  const launcher = new LocalProfileLauncher({ fetchImpl: async () => { calls += 1; throw new Error("timeout"); } });
  await assert.rejects(launcher.start("fixture"), (e) => e.retainBrowserLock === true);
  assert.equal(calls, 1);
  launcher.profileId = "fixture";
  await assert.rejects(launcher.stop(), (e) => e.retainBrowserLock === true);
  assert.equal(launcher.profileId, "fixture");
  const unavailable = new LocalProfileLauncher({ fetchImpl: async () => { throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }); } });
  await assert.rejects(unavailable.start("fixture"), (e) => e.retainBrowserLock === false);
});

test("scheduler isolates corrupt profiles and reports each changed error once", () => {
  const failures = new Map();
  const reports = [];
  const profiles = [{ profileId: "bad", enabled: true }, { profileId: "good", enabled: true }, { profileId: "disabled", enabled: false }];
  let broken = true;
  const options = {
    read: (p) => { if (p.profileId === "bad" && broken) throw new Error("corrupt state"); return emptyState(p); },
    write: () => {}, next: () => ({ at: new Date(), key: "window" }), report: (p, e) => reports.push([p.profileId, e.message]),
  };
  assert.deepEqual(planProfiles(profiles, failures, options).map((j) => j.profile.profileId), ["good"]);
  planProfiles(profiles, failures, options);
  assert.deepEqual(reports, [["bad", "corrupt state"]]);
  broken = false;
  assert.equal(planProfiles(profiles, failures, options).length, 2);
  assert.equal(failures.size, 0);
});

test("cancellation during the final gesture cannot be reported as session success", () => {
  const controller = new AbortController();
  const result = { aborted: false, postsSeen: 6, likes: 0 };
  controller.abort(new Error("Session interrupted by operator"));
  recordCancellation(result, controller.signal);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, "Session interrupted by operator");
  assert.equal(result.postsSeen, 6);
});

function feedWorld(html, rects = {}) {
  const { document, window } = parseHTML(html);
  const defaultRect = { x: 300, y: 200, top: 200, bottom: 500, width: 540, height: 300, left: 300, right: 840 };
  for (const el of document.querySelectorAll("*")) {
    const key = el.getAttribute("componentkey") || el.id || el.getAttribute("data-rect") || "";
    const rect = rects[key] || defaultRect;
    el.getBoundingClientRect = () => ({ ...rect });
    el.scrollIntoView = function scrollIntoView() {
      const moved = rects.afterReveal?.[key] || { ...rect, top: 180, bottom: 180 + (rect.height || 300), y: 180 };
      el.getBoundingClientRect = () => ({ ...moved });
      for (const child of el.querySelectorAll("*")) {
        child.getBoundingClientRect = () => ({ ...moved, height: 36, bottom: moved.top + 36, width: 80 });
      }
    };
  }
  const sandbox = {
    document,
    window: { innerHeight: 900, ...(window || {}) },
    innerHeight: 900,
    location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
    getComputedStyle: () => ({ visibility: "visible" }),
    URL,
  };
  // feedDomWorld closes over document/window from the page; bind via vm with globals.
  Object.assign(sandbox, { document, window: sandbox.window });
  const helpers = vm.runInNewContext(`(${feedDomHelpers.toString()})()`, sandbox);
  sandbox.helpers = helpers;
  const world = vm.runInNewContext(`(${feedDomWorld.toString()})(helpers)`, { ...sandbox, helpers, document, window: sandbox.window });
  return { document, world };
}

test("modern FeedType listitems are preferred over People You May Know panels", () => {
  const html = `<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed" componentkey="container-update-list_mainFeed-lazy-container" role="list">
        <div role="listitem" componentkey="pymk-1">
          People You May Know
          <button aria-label="Invite Bhavya Sharma to connect">Connect</button>
          <button aria-label="Invite Sajjan Gill to connect">Connect</button>
          Discover more
        </div>
        <div role="listitem" componentkey="expandedabcFeedType_MAIN_FEED_RELEVANCE" id="expandedabcFeedType_MAIN_FEED_RELEVANCE">
          Suggested Tahir Ali
          <button aria-label="Open control menu for post by Tahir Ali"></button>
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>
          <button aria-label="Repost">Repost</button>
          <div role="listitem" componentkey="nested-social">
            <button aria-label="Reaction button state: no reaction Like">Like</button>
            <button aria-label="Comment">Comment</button>
          </div>
        </div>
      </div>
    </main>
  </body></html>`;
  const { world } = feedWorld(html, {
    "expandedabcFeedType_MAIN_FEED_RELEVANCE": { x: 300, y: 1200, top: 1200, bottom: 1600, width: 540, height: 400, left: 300, right: 840 },
    "nested-social": { x: 300, y: 1500, top: 1500, bottom: 1540, width: 540, height: 40, left: 300, right: 840 },
    "pymk-1": { x: 300, y: 100, top: 100, bottom: 700, width: 540, height: 600, left: 300, right: 840 },
    afterReveal: {
      "expandedabcFeedType_MAIN_FEED_RELEVANCE": { x: 300, y: 180, top: 180, bottom: 580, width: 540, height: 400, left: 300, right: 840 },
    },
  });
  const dump = world.dump();
  assert.equal(dump.socialPosts, 1);
  assert.match(dump.firstCard.componentkey, /FeedType_MAIN_FEED_RELEVANCE/);
  assert.equal(world.collect().length, 0);
  const revealed = world.collect({ reveal: true });
  assert.equal(revealed.length, 1);
  assert.match(revealed[0].urn, /FeedType_MAIN_FEED_RELEVANCE/);
});

test("blocking modal close control is dismissed before collecting posts", () => {
  let closed = false;
  const html = `<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expandedxyzFeedType_MAIN_FEED_RELEVANCE">
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>
        </div>
      </div>
    </main>
    <div role="dialog" aria-modal="true"><video></video><button aria-label="Close modal dialog">X</button></div>
  </body></html>`;
  const { document, world } = feedWorld(html, {
    "expandedxyzFeedType_MAIN_FEED_RELEVANCE": { x: 300, y: 160, top: 160, bottom: 520, width: 540, height: 360, left: 300, right: 840 },
  });
  const closeBtn = [...document.querySelectorAll("button")].find((b) => /close modal dialog/i.test(b.getAttribute("aria-label") || ""));
  closeBtn.click = () => { closed = true; };
  assert.equal(world.dismissBlockingModals(), true);
  assert.equal(closed, true);
  assert.equal(world.collect().length, 1);
});

