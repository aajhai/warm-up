import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const root = mkdtempSync(join(tmpdir(), "warmup-test-"));
process.env.WARMUP_DATA_DIR = root;
process.env.WARMUP_LOG_DIR = join(root, "logs");
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
const { getWorkingPage, refreshStaleFeed, likePost, expandPost, maybeSeeNewPosts } = await import("../src/scenario/linkedinFeed.js");
const { LocalProfileLauncher } = await import("../src/gologin/local.js");
const { CloudProfileLauncher } = await import("../src/gologin/cloud.js");
const { planProfiles } = await import("../src/service.js");
const { recordCancellation } = await import("../src/util/cancellation.js");
const { failureKind, isInfrastructureFailure, isRecoverablePointerStall } = await import("../src/util/failures.js");
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
  assert.equal(restarted.daily["2026-09-14"].aborted, 0);
  assert.equal(restarted.daily["2026-09-14"].infraFailures, 1);
});

test("interrupted workers preserve feed progress without consuming the account abort cap", () => {
  const now = new Date("2026-09-14T06:00:00Z");
  const state = emptyState();
  beginRun(state, { testRun: false }, now, () => {});
  state.currentRun.progress = { postsSeen: 17, expanded: 3, likes: 1, seeNewPosts: 0 };
  recoverInterruptedRun(state, () => {});
  assert.equal(state.daily["2026-09-14"].postsSeen, 17);
  assert.equal(state.daily["2026-09-14"].aborted, 0);
  assert.equal(state.daily["2026-09-14"].infraFailures, 1);
  assert.equal(state.daily["2026-09-14"].sessions, 0);
  assert.equal(state.lastSession.postsSeen, 17);
  assert.equal(state.lastSession.expanded, 3);
  assert.equal(state.lastSession.failureKind, "infra");
});

test("CDP, deadline, and target-close failures are classified as infrastructure", () => {
  for (const message of [
    "Protocol error (Runtime.callFunctionOn): Target closed",
    "Runtime.callFunctionOn timed out",
    "Session exceeded its execution deadline",
    "Mac slept or execution stalled; ending this session",
  ]) {
    const error = new Error(message);
    assert.equal(isInfrastructureFailure(error), true);
    assert.equal(failureKind(error), "infra");
  }
  assert.equal(failureKind(new Error("Feed rendered without readable posts")), "scenario");
  assert.equal(isRecoverablePointerStall(new Error("CDP mouse event timed out")), true);
  assert.equal(isInfrastructureFailure(new Error("CDP mouse event timed out")), false);
  assert.equal(isInfrastructureFailure(new Error("CDP mouse session attach timed out")), false);
  assert.equal(isInfrastructureFailure(new Error("Protocol error (Input.dispatchMouseEvent): Target closed")), true);
});

test("optimizer excludes infrastructure failures from production session and abort caps", () => {
  const state = emptyState();
  const optimizer = new Optimizer(state);
  const run = beginRun(state, { testRun: false }, new Date(), () => {});
  optimizer.plan = { testRun: false };
  optimizer.postflight({ likes: 0, connections: 0, postsSeen: 9, expanded: 2, durationMs: 1000, aborted: true, checkpoint: false, failureKind: "infra", reason: "CDP timeout", deniedReasons: {} });
  const day = state.daily[run.dayKey];
  assert.equal(day.sessions, 0);
  assert.equal(day.aborted, 0);
  assert.equal(day.infraFailures, 1);
  assert.equal(state.lastSession.postsSeen, 9);
  assert.equal(state.lastSession.expanded, 2);
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

test("scheduler covers the full IST day", () => {
  for (const now of [
    new Date("2026-09-13T19:00:00Z"), // 00:30 IST
    new Date("2026-09-14T06:30:00Z"), // 12:00 IST
    new Date("2026-09-14T17:30:00Z"), // 23:00 IST
  ]) {
    const state = emptyState();
    const next = nextRunAt(state, now, () => 0.5);
    assert.ok(next.at.getTime() > now.getTime());
    assert.equal(next.dateKey, istNow(now).dateKey);
  }
});

test("live process locks exclude another runner and cannot be unlocked", () => {
  const directory = join(root, "locks");
  const release = acquireLock("browser", directory);
  assert.throws(() => acquireLock("browser", directory), /holds/);
  assert.throws(() => unlockStoppedProcess("browser", directory), /still running/);
  release();
  acquireLock("browser", directory)();
});

test("a lock left by a dead process is reclaimed atomically", () => {
  const directory = join(root, "stale-locks");
  const path = join(directory, "browser.json");
  const releaseInitial = acquireLock("browser", directory);
  const stale = JSON.parse(readFileSync(path, "utf8"));
  stale.pid = 2_147_483_647;
  writeFileSync(path, JSON.stringify(stale));
  const releaseRecovered = acquireLock("browser", directory);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  releaseInitial();
  releaseRecovered();
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
  // Invitation limits are read from overlays only; page body text (including post text) never pauses the account.
  assert.equal(classifyAccount("https://www.linkedin.com/mynetwork/", "You've reached your weekly invitation limit"), null);
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

// Grow picks cards randomly in production; fixtures with a fixed hit target pin the pick.
const firstCard = (list) => ({ candidate: list[0] || null, skipped: [] });

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
  button.setAttribute("aria-label", "Pending, click to withdraw");
  button.textContent = "";
  assert.equal(world.pending({ url: candidates[0].url }), true);
  assert.equal(world.inspect().length, 0);
});

test("Grow cards with mutual profile links match the invited person", () => {
  const html = `<main>
    <div class="card">
      <a href="https://www.linkedin.com/in/vinayak-yadav">Vinayak Yadav</a>
      <a href="https://www.linkedin.com/in/mutual-one">Mutual One</a>
      <a href="https://www.linkedin.com/in/mutual-two">Mutual Two</a>
      <button aria-label="Invite Vinayak Yadav to connect">Connect</button>
    </div>
    <div class="card">
      <a href="https://www.linkedin.com/in/someone">Someone Else</a>
      <a href="https://www.linkedin.com/in/other">Other Person</a>
      <button aria-label="Invite Nobody Known to connect">Connect</button>
    </div>
  </main>`;
  const { world } = domWorld(html);
  const candidates = world.inspect();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://www.linkedin.com/in/vinayak-yadav");
  assert.equal(candidates[0].name, "Vinayak Yadav");
});

test("Grow cards match an invited name when the profile link also contains the headline", () => {
  const html = `<main><div class="card">
    <a href="https://www.linkedin.com/in/vinayak-yadav/overlay/about-this-profile/">Vinayak Yadav Network Security Trainee @ Network Bulls | Routing</a>
    <a href="https://www.linkedin.com/in/rohit-kumar">Rohit Kumar</a>
    <button aria-label="Invite Vinayak Yadav to connect">Connect</button>
  </div></main>`;
  const { world } = domWorld(html);
  const candidates = world.inspect();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://www.linkedin.com/in/vinayak-yadav");
  assert.equal(candidates[0].name, "Vinayak Yadav");
});

test("Grow cards use the profile link before the invited name when that link has no text", () => {
  const html = `<main><div class="card">
    <a href="https://www.linkedin.com/in/junnu-rain-khan"><img alt=""></a>
    <span>Junnu Rain Khan</span>
    <span>Network trainee</span>
    <a href="https://www.linkedin.com/in/rohit-kumar">Rohit Kumar</a>
    <button aria-label="Invite Junnu Rain Khan to connect">Connect</button>
  </div></main>`;
  const { world } = domWorld(html);
  const candidates = world.inspect();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://www.linkedin.com/in/junnu-rain-khan");
  assert.equal(candidates[0].name, "Junnu Rain Khan");
});

test("a row of Connect buttons still matches each invited name to its own profile link", () => {
  const html = `<main><div class="row">
    <a href="https://www.linkedin.com/in/junnu-rain-khan"><img alt=""></a>
    <span>Junnu Rain Khan</span>
    <div><button aria-label="Invite Junnu Rain Khan to connect">Connect</button></div>
    <a href="https://www.linkedin.com/in/rajat-agrawal"><img alt=""></a>
    <span>Rajat Agrawal</span>
    <div><button aria-label="Invite Rajat Agrawal to connect">Connect</button></div>
  </div></main>`;
  const { world } = domWorld(html);
  const candidates = world.inspect();
  assert.equal(candidates.map((c) => String(c.url)).join("|"), "https://www.linkedin.com/in/junnu-rain-khan|https://www.linkedin.com/in/rajat-agrawal");
});

test("a zero-size dialog does not suppress Grow Connect cards", () => {
  const { document, world } = domWorld('<main><div role="dialog" id="hidden"></div><div class="card"><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></div></main>');
  document.querySelector("#hidden").getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, width: 0, height: 0 });
  const candidates = world.inspect();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://www.linkedin.com/in/amy");
});

test("Grow carousel Connect cards are each a candidate even when they share a row", () => {
  const html = `<main><div class="carousel">
    <div class="card"><a href="https://www.linkedin.com/in/ayaz-shaikh">Ayaz Shaikh</a><button>Connect</button></div>
    <div class="card"><a href="https://www.linkedin.com/in/divyesh-wani">Divyesh Wani</a><button>Connect</button></div>
    <div class="card"><a href="https://www.linkedin.com/in/dhruv-tanwar">Dhruv Tanwar</a><button>Connect</button></div>
  </div></main>`;
  const { world } = domWorld(html);
  const candidates = world.inspect();
  assert.equal(candidates.length, 3);
  assert.equal(candidates.map((c) => c.name).join("|"), "Ayaz Shaikh|Divyesh Wani|Dhruv Tanwar");
});

test("sent invitations count as pending when the control says Withdraw", () => {
  const { world } = domWorld('<main><li><a href="https://www.linkedin.com/in/amy">Amy Example</a><a href="https://www.linkedin.com/company/acme">Acme</a><button aria-label="Withdraw invitation">Withdraw</button></li></main>');
  assert.equal(world.pending({ url: "https://www.linkedin.com/in/amy" }), true);
  assert.equal(world.pending({ url: "https://www.linkedin.com/in/ben" }), false);
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
      const result = await runConnectionBatch(page, state, { maxAttempts: 1, gapRange: [0, 0], pause: async () => {} });
      assert.equal(clicks, 1);
      assert.equal(result.attempted, 1);
      assert.equal(result.connections, confirms ? 1 : 0);
      assert.equal(result.accountBlock ?? null, null);
      assert.equal(loadState().actions[0].status, confirms ? "confirmed" : "not_sent", "a card that still offers Connect after reload was not sent");
      assert.equal(Object.values(loadState().weekly)[0].used, 1);
    }
  } finally { Object.assign(config, previous); }
});

test("a card that still says Connect is rechecked after reload and does not pause the profile", async () => {
  const previous = { ...config };
  try {
    config.connectionsEnabled = true;
    const { document, world } = domWorld('<main><li id="amy"><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li><li><a href="https://www.linkedin.com/in/ben">Ben Example</a><button>Connect</button></li></main>');
    const button = document.querySelector("#amy button");
    document.elementFromPoint = () => button;
    let url = "https://www.linkedin.com/mynetwork/grow/";
    let reloads = 0;
    const state = emptyState();
    beginRun(state, { testRun: false, connectionTrial: true });
    const page = {
      url: () => url,
      goto: async (to) => { url = to; },
      reload: async () => { reloads += 1; button.textContent = "Pending"; },
      evaluate: async (fn, ...args) => args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true },
      mouse: { move: async () => {}, click: async () => {}, wheel: async () => {} },
    };
    const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: async () => {}, pickCandidate: firstCard });
    assert.equal(reloads, 1);
    assert.equal(result.connections, 1);
    assert.equal(result.accountBlock ?? null, null);
    assert.equal(loadState().actions[0].status, "confirmed");
    assert.equal(state.pause, null);
  } finally { Object.assign(config, previous); }
});

test("a My Network click that detaches the feed frame continues on the live page", async () => {
  const previous = { ...config };
  try {
    config.connectionsEnabled = true;
    const { document, world } = domWorld('<a href="/mynetwork/">My Network</a><main><li><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li></main>');
    const button = document.querySelector("button");
    document.elementFromPoint = () => button;
    let url = "https://www.linkedin.com/feed/";
    let phase = "feed";
    let clicks = 0;
    const state = emptyState();
    beginRun(state, { testRun: false, connectionTrial: true });
    const page = {
      url() {
        if (phase === "detaching") throw new Error("Attempted to use detached Frame '969E6109CA8CF6355F5AF6B8EEEA0832'.");
        return url;
      },
      goto: async (to) => { phase = "live"; url = to; },
      evaluate: async (fn, ...args) => {
        if (phase === "detaching") throw new Error("Attempted to use detached Frame '969E6109CA8CF6355F5AF6B8EEEA0832'.");
        return args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true };
      },
      mouse: {
        move: async () => {},
        click: async () => {
          clicks += 1;
          if (clicks === 1) {
            phase = "detaching";
            url = "https://www.linkedin.com/mynetwork/grow/";
            throw new Error("Attempted to use detached Frame '969E6109CA8CF6355F5AF6B8EEEA0832'.");
          }
          button.textContent = "Pending";
        },
        wheel: async () => {},
      },
      browser: () => ({ pages: async () => [page] }),
    };
    const result = await runConnectionBatch(page, state, {
      maxAttempts: 1,
      pause: async () => { if (phase === "detaching") phase = "live"; },
    });
    assert.equal(clicks, 2);
    assert.equal(result.connections, 1);
    assert.equal(result.accountBlock, null);
  } finally { Object.assign(config, previous); }
});

test("connection confirmation keeps polling until Pending appears after the click", async () => {
  const previous = { ...config };
  try {
    const { document, world } = domWorld('<main><li><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li></main>');
    const button = document.querySelector("button");
    document.elementFromPoint = () => button;
    let url = "https://www.linkedin.com/feed/";
    let pauses = 0;
    let pressed = false;
    const state = emptyState();
    beginRun(state, { testRun: false, connectionTrial: true });
    const page = {
      url: () => url, goto: async (to) => { url = to; },
      evaluate: async (fn, ...args) => args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true },
      mouse: { move: async () => {}, click: async () => { pressed = true; } },
    };
    const result = await runConnectionBatch(page, state, {
      maxAttempts: 1,
      pause: async () => {
        if (!pressed) return;
        pauses += 1;
        if (pauses === 5) button.textContent = "Pending";
      },
    });
    assert.ok(pauses >= 5);
    assert.equal(result.connections, 1);
    assert.equal(loadState().actions[0].status, "confirmed");
  } finally { Object.assign(config, previous); }
});

test("removing the suggestion card after Connect counts as sent when other suggestions remain", async () => {
  const previous = { ...config };
  try {
    const { document, world } = domWorld('<main><li id="amy"><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li><li><a href="https://www.linkedin.com/in/ben">Ben Example</a><button>Connect</button></li></main>');
    const button = document.querySelector("#amy button");
    document.elementFromPoint = () => button;
    let url = "https://www.linkedin.com/feed/";
    const state = emptyState();
    beginRun(state, { testRun: false, connectionTrial: true });
    const page = {
      url: () => url, goto: async (to) => { url = to; },
      evaluate: async (fn, ...args) => args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true },
      mouse: { move: async () => {}, click: async () => { document.querySelector("#amy")?.remove(); } },
    };
    const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: async () => {}, pickCandidate: firstCard });
    assert.equal(result.connections, 1);
    assert.equal(result.accountBlock, null);
    assert.equal(loadState().actions[0].status, "confirmed");
  } finally { Object.assign(config, previous); }
});

test("removing the last remaining suggestion card after Connect still counts as sent", async () => {
  const previous = { ...config };
  try {
    const { document, world } = domWorld('<main><li id="amy"><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li></main>');
    const button = document.querySelector("#amy button");
    document.elementFromPoint = () => button;
    let url = "https://www.linkedin.com/feed/";
    const state = emptyState();
    beginRun(state, { testRun: false, connectionTrial: true });
    const page = {
      url: () => url, goto: async (to) => { url = to; },
      evaluate: async (fn, ...args) => args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true },
      mouse: { move: async () => {}, click: async () => { document.querySelector("#amy")?.remove(); } },
    };
    const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: async () => {}, pickCandidate: firstCard });
    assert.equal(result.connections, 1);
    assert.equal(result.accountBlock, null);
    assert.equal(loadState().actions[0].status, "confirmed");
  } finally { Object.assign(config, previous); }
});

test("connection trials consume production slots, allow no likes, and cannot combine with test mode", () => {
  const previous = { ...config };
  try {
    Object.assign(config, { connectionTrial: true, testRun: false });
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

test("daily caps: 4 production sessions, 3 account failures, 6 infrastructure failures (profile-only skip)", () => {
  const previous = { ...config };
  try {
    Object.assign(config, { allowBlockedDay: false, testRun: false, connectionTrial: false });
    const state = emptyState();
    const day = getDayStats(state, istNow().dateKey);
    day.aborted = 2;
    day.sessions = 3;
    day.infraFailures = 5;
    assert.equal(new Optimizer(state).preflight().allow, true);
    day.aborted = 3;
    assert.match(new Optimizer(state).preflight().reason, /3 failed production sessions/);
    day.aborted = 0;
    day.sessions = 4;
    assert.match(new Optimizer(state).preflight().reason, /4 production sessions/);
    day.sessions = 0;
    day.infraFailures = 6;
    const infra = new Optimizer(state).preflight();
    assert.match(infra.reason, /6 infrastructure failures/);
    assert.equal(state.pause, null, "an infra cap skips the day without pausing the profile");
    // Another profile's state is untouched by this profile's infra failures.
    assert.equal(new Optimizer(emptyState({ profileId: "other", profileName: "Other" })).preflight().allow, true);
  } finally { Object.assign(config, previous); }
});

test("test runs have zero likes; prospective like rate includes the next action", () => {
  const previous = { ...config };
  try {
    config.testRun = true;
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

test("a single CDP mouse timeout then a successful retry keeps the pointer alive", async () => {
  let sends = 0;
  let detached = 0;
  const page = {
    bringToFront: async () => {},
    createCDPSession: async () => ({
      send: async () => {
        sends += 1;
        if (sends === 1) {
          await new Promise(() => {});
        }
      },
      detach: async () => { detached += 1; },
    }),
  };
  const pointer = new TrustedPointer(page, { commandTimeoutMs: 40 });
  await pointer.wheel(120);
  assert.equal(pointer.dead, false);
  assert.equal(pointer.strikes, 0);
  assert.ok(sends >= 2);
  assert.ok(detached >= 1);
  assert.equal(isInfrastructureFailure(new Error("CDP mouse event timed out")), false);
});

test("browse scroll CDP timeouts do not abort while non-advancing scrolls still trip the stuck-feed path", async () => {
  const { isInfrastructureFailure: infra } = await import("../src/util/failures.js");
  const stall = new Error("CDP mouse event timed out");
  assert.equal(infra(stall), false);
  // Mimic the browse loop: recoverable stall increments stuck; Target closed still aborts.
  let stuck = 0;
  const browseCatch = (error) => {
    if (infra(error)) throw error;
    stuck += 1;
  };
  browseCatch(stall);
  browseCatch(stall);
  assert.equal(stuck, 2);
  assert.throws(() => browseCatch(new Error("Protocol error: Target closed")), /Target closed/);
  stuck = 7;
  browseCatch(stall);
  assert.equal(stuck, 8);
  const reason = stuck >= 8 ? "Feed did not advance after repeated scroll attempts" : null;
  assert.equal(reason, "Feed did not advance after repeated scroll attempts");
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

test("New posts and See new posts are both the load-more control", () => {
  const { world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expandedabcFeedType_MAIN_FEED_RELEVANCE" data-rect="post">A real post</div>
        <button data-rect="pill">New posts</button>
      </div>
    </main>
  </body></html>`, {
    post: { x: 411, y: 180, top: 180, bottom: 640, left: 411, right: 963, width: 552, height: 460 },
    pill: { x: 560, y: 660, top: 660, bottom: 696, left: 560, right: 720, width: 160, height: 36 },
  });
  const found = world.findSeeNewPosts();
  assert.equal(found.label, "New posts");
  assert.ok(found.y > 600);
  const probe = world.probe(found.x, found.y, "see-new");
  assert.equal(probe.safe, true);
});

test("Hindi नई पोस्ट देखें is the same load-more control as See new posts", () => {
  const { world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expandedabcFeedType_MAIN_FEED_RELEVANCE" data-rect="post">एक पोस्ट</div>
        <button data-rect="pill">नई पोस्ट देखें</button>
      </div>
    </main>
  </body></html>`, {
    post: { x: 411, y: 180, top: 180, bottom: 640, left: 411, right: 963, width: 552, height: 460 },
    pill: { x: 560, y: 660, top: 660, bottom: 696, left: 560, right: 720, width: 160, height: 36 },
  });
  const found = world.findSeeNewPosts();
  assert.equal(found.label, "नई पोस्ट देखें");
  assert.ok(found.y > 600);
  const probe = world.probe(found.x, found.y, "see-new");
  assert.equal(probe.safe, true);
  assert.equal(probe.reason, undefined);
});

test("Hindi नई पोस्ट short label also matches the load-more control", () => {
  const { world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <button data-rect="pill">नई पोस्ट</button>
      </div>
    </main>
  </body></html>`, {
    pill: { x: 560, y: 210, top: 210, bottom: 242, left: 560, right: 700, width: 140, height: 32 },
  });
  const found = world.findSeeNewPosts();
  assert.equal(found.label, "नई पोस्ट");
  assert.equal(world.probe(found.x, found.y, "see-new").safe, true);
});

test("See new posts is found in the lower viewport, not only the top 220px", async () => {
  const { seeNewPostsVisible } = await import("../src/scenario/linkedinDom.js");
  assert.equal(seeNewPostsVisible({ top: 40, height: 32, width: 140, bottom: 72 }, 900), true);
  assert.equal(seeNewPostsVisible({ top: 700, height: 36, width: 150, bottom: 736 }, 900), true);
  assert.equal(seeNewPostsVisible({ top: 920, height: 36, width: 150, bottom: 956 }, 900), false);
  assert.equal(seeNewPostsVisible({ top: 700, height: 8, width: 150, bottom: 708 }, 900), false);
});

test("stale-feed recovery never reloads or jumps when no See new posts pill was clicked", async () => {
  let navigations = 0;
  let softJumps = 0;
  const page = {
    evaluate: async () => null,
    goto: async () => { navigations += 1; },
  };
  const human = {
    scrollOffset: async () => ({ top: 450, maxTop: 2000 }),
    clickAt: async () => false,
    ensureOverFeed: async () => {},
    postsCacheAt: 0,
  };
  const originalEvaluate = page.evaluate;
  page.evaluate = async (...args) => {
    if (args.length === 1) softJumps += 1;
    return originalEvaluate(...args);
  };
  assert.equal(await refreshStaleFeed(page, human, { postsSeen: 20, stuck: 4, seeNewPosts: 0 }), false);
  assert.equal(navigations, 0);
  assert.equal(softJumps, 0);
});

test("a no-op pointer wheel falls back to one DOM scroll", async () => {
  let top = 0;
  let domScrolls = 0;
  const page = {
    evaluate: async (_, input) => { domScrolls += 1; top += input.deltaY; },
  };
  const human = new HumanController(page);
  human.pointer = { x: 500, y: 300, coords: () => ({ x: 500, y: 300 }), wheel: async () => {} };
  human.ensureOverFeed = async () => {};
  human.followContent = async () => {};
  human.scrollOffset = async () => ({ top, maxTop: 3000, firstUrn: "fixture", firstTop: 200 - top });
  const result = await human.scrollFeed({ reverseChance: 0 });
  assert.equal(domScrolls, 1);
  assert.equal(result.fallback, true);
  assert.ok(result.moved > 0);
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
  assert.ok(wheels[0] > 100 && wheels[0] <= 260);
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

test("Gmail and Bing tabs open LinkedIn before the session check", async () => {
  for (const start of ["https://mail.google.com/mail/u/0/#inbox", "https://www.bing.com/images?FORM=Z9LH"]) {
    let href = start;
    const gotos = [];
    const page = {
      url: () => href,
      goto: async (target) => {
        gotos.push(target);
        href = "https://www.linkedin.com/feed/";
      },
      bringToFront: async () => {},
      createCDPSession: async () => ({
        send: async (method) => method === "Target.getTargetInfo" ? { targetInfo: { targetId: "fixture" } } : { windowId: 1, bounds: { windowState: "normal" } },
        detach: async () => {},
      }),
    };
    const chosen = await getWorkingPage({ pages: async () => [page] });
    assert.equal(chosen, page);
    assert.deepEqual(gotos, ["https://www.linkedin.com/"]);
  }
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
  assert.deepEqual(calls.map((c) => c.body), [{
    profileId: "fixture",
    sync: true,
    args: [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-dev-shm-usage",
      "--disable-features=Vulkan",
      "--use-gl=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  }, { profileId: "fixture" }]);
  assert.ok(calls.every((c) => c.url.startsWith("http://127.0.0.1:36912/") && c.redirect === "error"));
  for (const wsUrl of ["ws://attacker.invalid/devtools/browser/a", "https://127.0.0.1/devtools/browser/a", "ws://user:pass@127.0.0.1/devtools/browser/a", "ws://127.0.0.1/wrong", undefined]) {
    const invalid = new LocalProfileLauncher({ fetchImpl: async () => Response.json({ status: "success", wsUrl }) });
    await assert.rejects(invalid.start("fixture"), (e) => e.retainBrowserLock === true);
  }
});

test("local GoLogin non-JSON responses surface a bounded, redacted body snippet", async () => {
  const body = `<html>\n\n  <body>  Bad   gateway\tAuthorization: Bearer abc.def-123 token=secret123 fixture-token
    eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ${"x".repeat(500)}</body></html>`;
  const launcher = new LocalProfileLauncher({ token: "fixture-token", fetchImpl: async () => new Response(body, { status: 502 }) });
  let message = "";
  await assert.rejects(launcher.start("fixture"), (e) => { message = e.message; return e.retainBrowserLock === true; });
  assert.match(message, /^GoLogin local start returned an invalid response \(HTTP 502\): "<html> <body> Bad gateway Authorization: \[redacted\]/);
  for (const secret of ["abc.def-123", "secret123", "fixture-token", "eyJhbGci", "\n", "\t", "  "]) assert.ok(!message.includes(secret), secret);
  const snippet = JSON.parse(message.match(/: (".*")\. Inspect/)[1]);
  assert.ok(snippet.length <= 200);
  launcher.profileId = "fixture";
  launcher.fetch = async () => new Response("  not json  ", { status: 200 });
  await assert.rejects(launcher.stop(), (e) => e.retainBrowserLock === true
    && e.message.startsWith('GoLogin local stop returned an invalid response (HTTP 200): "not json".'));
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
  assert.equal(result.failureKind, "infra");
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
  document.elementFromPoint = (x, y) => {
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll("button, [role='button'], a")) {
      const r = el.getBoundingClientRect();
      if (x < r.x || y < r.y || x > r.x + r.width || y > r.y + r.height) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };
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

test("a feed list scrolled above the viewport is pulled back so the center column is not blank", () => {
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <aside>Prakash Kharwar Administrative Assistant at Abbott</aside>
      <div data-testid="mainFeed" data-rect="feed" role="list">
        <div role="listitem" data-rect="composer">Start a post Video Photo Write article</div>
      </div>
      <aside>LinkedIn News Top stories</aside>
    </main>
  </body></html>`, {
    feed: { x: 411, y: -224, top: -224, bottom: -88, left: 411, right: 963, width: 552, height: 136 },
    composer: { x: 411, y: -224, top: -224, bottom: -108, left: 411, right: 963, width: 552, height: 116 },
  });
  const workspace = document.querySelector("main#workspace");
  workspace.scrollTop = 300;
  const before = world.columnState();
  assert.equal(before.feedVisible, false);
  assert.equal(before.visibleUpdates, 0);
  const healed = world.healFeedColumn();
  assert.equal(healed.healed, true);
  assert.ok(workspace.scrollTop < 300);
  assert.equal(workspace.scrollTop, 72);
});

test("an on-screen composer with no update cards is scrolled back toward the loaded posts", () => {
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" data-rect="feed" role="list">
        <div role="listitem" data-rect="composer">Start a post Video Photo</div>
        <button data-rect="pill">See new posts</button>
      </div>
    </main>
  </body></html>`, {
    feed: { x: 411, y: 80, top: 80, bottom: 280, left: 411, right: 963, width: 552, height: 200 },
    composer: { x: 411, y: 80, top: 80, bottom: 196, left: 411, right: 963, width: 552, height: 116 },
    pill: { x: 560, y: 210, top: 210, bottom: 242, left: 560, right: 700, width: 140, height: 32 },
  });
  const workspace = document.querySelector("main#workspace");
  workspace.scrollTop = 800;
  const before = world.columnState();
  assert.equal(before.feedVisible, true);
  assert.equal(before.visibleUpdates, 0);
  const healed = world.healFeedColumn();
  assert.equal(healed.healed, true);
  assert.equal(workspace.scrollTop, 440);
});

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

test("count-only reaction toggles are likeable; the reactions-menu chevron is not", () => {
  const html = `<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expandedcountFeedType_MAIN_FEED_RELEVANCE" id="expandedcountFeedType_MAIN_FEED_RELEVANCE">
          A long enough post body so this card looks like real feed content for liking.
          <button data-rect="like-btn" aria-label="Reaction button state: no reaction 4"></button>
          <button data-rect="menu-btn" aria-label="Open reactions menu"></button>
          <button data-rect="comment-btn" aria-label="Comment 1">Comment</button>
        </div>
      </div>
    </main>
  </body></html>`;
  const { world } = feedWorld(html, {
    "expandedcountFeedType_MAIN_FEED_RELEVANCE": { x: 300, y: 220, top: 220, bottom: 700, width: 540, height: 480, left: 300, right: 840 },
    "like-btn": { x: 320, y: 640, top: 640, bottom: 676, width: 88, height: 36, left: 320, right: 408 },
    "menu-btn": { x: 410, y: 640, top: 640, bottom: 676, width: 36, height: 36, left: 410, right: 446 },
    "comment-btn": { x: 460, y: 640, top: 640, bottom: 676, width: 88, height: 36, left: 460, right: 548 },
  });
  const posts = world.collect();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].hasLike, true);
  assert.equal(posts[0].liked, false);
  assert.ok(world.inspect().likeButtons >= 1);
  const point = world.locate(posts[0].urn, "like");
  assert.ok(point);
  const hit = world.probe(point.x, point.y, "like", posts[0].urn);
  assert.equal(hit.safe, true);
  const chevron = world.probe(428, 658, "like", posts[0].urn);
  assert.equal(chevron.safe, false);
  assert.equal(chevron.reason, "not-like-button");
});

test("a reaction picker gets one Escape and a state check; Like is never pressed again", async () => {
  for (const stuck of [true, false]) {
    let menuOpen = false;
    let escapes = 0;
    let clicks = 0;
    const flags = [];
    const page = {
      keyboard: { press: async (key) => { if (key === "Escape") escapes += 1; menuOpen = false; } },
      evaluate: async (_fn, _worldSrc, _helpersSrc, name) => {
        if (name === "reactionMenuOpen") return menuOpen;
        if (name === "mediaOverlayOpen") return false;
        if (name === "isLiked") return stuck;
        return null;
      },
    };
    const human = {
      revealControl: async () => ({ x: 330, y: 650, label: "Reaction button state: no reaction Like" }),
      clickAt: async (_x, _y, kind, _urn, opts = {}) => {
        assert.equal(kind, "like");
        clicks += 1;
        flags.push({ shortPress: Boolean(opts.shortPress), singlePress: Boolean(opts.singlePress) });
        menuOpen = true;
        return true;
      },
    };
    assert.equal(await likePost(page, human, { urn: `urn:fixture-like-${stuck}` }), stuck);
    assert.equal(clicks, 1);
    assert.equal(escapes, 1);
    assert.deepEqual(flags, [{ shortPress: true, singlePress: true }]);
  }
});

test("a refused Like or More hit check is not re-located or pressed again", async () => {
  for (const kind of ["like", "more"]) {
    let reveals = 0;
    let clicks = 0;
    const human = {
      revealControl: async () => { reveals += 1; return { x: 330, y: 650, label: kind }; },
      clickAt: async (_x, _y, _kind, _urn, opts) => { clicks += 1; assert.equal(opts.singlePress, true); return false; },
      waitAfterExpand: async () => {},
    };
    const page = { keyboard: { press: async () => {} }, evaluate: async () => false };
    const ok = kind === "like" ? await likePost(page, human, { urn: "urn:x" }) : await expandPost(page, human, { urn: "urn:x" });
    assert.equal(ok, false);
    assert.equal(reveals, 1);
    assert.equal(clicks, 1);
  }
});

test("like click that never sticks after a picker retry logs did-not-stick", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(String(args[0] || "")); originalWarn(...args); };
  try {
    let menuOpen = true;
    const page = {
      keyboard: { press: async () => { menuOpen = false; } },
      evaluate: async (_fn, _worldSrc, _helpersSrc, name) => {
        if (name === "reactionMenuOpen") return menuOpen;
        if (name === "mediaOverlayOpen") return false;
        if (name === "isLiked") return false;
        return null;
      },
    };
    const human = {
      revealControl: async () => ({ x: 330, y: 650, label: "Like" }),
      clickAt: async () => {
        menuOpen = true;
        return true;
      },
    };
    assert.equal(await likePost(page, human, { urn: "urn:fixture-picker" }), false);
    assert.ok(warnings.some((line) => /Like click did not stick/i.test(line)));
  } finally {
    console.warn = originalWarn;
  }
});

test("clean like still works without opening the reaction picker", async () => {
  const human = {
    revealControl: async () => ({ x: 330, y: 650, label: "Like" }),
    clickAt: async () => true,
  };
  const page = {
    keyboard: { press: async () => {} },
    evaluate: async (_fn, _worldSrc, _helpersSrc, name) => {
      if (name === "reactionMenuOpen") return false;
      if (name === "mediaOverlayOpen") return false;
      if (name === "isLiked") return true;
      return null;
    },
  };
  assert.equal(await likePost(page, human, { urn: "urn:clean-like" }), true);
});

test("approved More expand logs when locate misses and does not count as expanded", async () => {
  const warnings = [];
  const infos = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => { warnings.push(String(args[0] || "")); originalWarn(...args); };
  console.log = (...args) => { infos.push(String(args[0] || "")); originalLog(...args); };
  try {
    const human = {
      revealControl: async () => null,
      waitAfterExpand: async () => {},
    };
    assert.equal(await expandPost({}, human, { urn: "urn:missing-more" }), false);
    assert.ok(warnings.some((line) => /Approved More expand did not run/i.test(line) && /locate-miss/i.test(line)));
    assert.equal(infos.some((line) => /Expanded post via More/i.test(line)), false);

    const successHuman = {
      revealControl: async () => ({ x: 400, y: 200, label: "… more" }),
      clickAt: async () => true,
      waitAfterExpand: async () => {},
    };
    assert.equal(await expandPost({}, successHuman, { urn: "urn:more-ok" }), true);
    assert.ok(infos.some((line) => /Expanded post via More/i.test(line)));
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("See new posts does not increment when the feed column stays the same height", async () => {
  const column = { feedHeight: 800, visibleUpdates: 2 };
  let clicks = 0;
  const human = {
    clickAt: async () => {
      clicks += 1;
      return true;
    },
    postsCacheAt: 0,
  };
  const page = {
    evaluate: async (_fn, _worldSrc, _helpersSrc, name) => {
      if (name === "findSeeNewPosts") return { x: 500, y: 200, label: "See new posts" };
      if (name === "columnState") return { ...column };
      return null;
    },
  };
  const stats = { seeNewPosts: 0, stuck: 3, seeNewMisses: 0 };
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => {
    fake += 3_000;
    return fake;
  };
  try {
    assert.equal(await maybeSeeNewPosts(page, human, stats), false);
    assert.equal(stats.seeNewPosts, 0);
    assert.equal(stats.seeNewMisses, 1);
    assert.equal(stats.stuck, 4);
    assert.equal(clicks, 1);

    // Second miss still attempts once, then the miss cap blocks further clicks.
    fake = realNow();
    assert.equal(await maybeSeeNewPosts(page, human, stats), false);
    assert.equal(stats.seeNewMisses, 2);
    assert.equal(clicks, 2);

    fake = realNow();
    assert.equal(await maybeSeeNewPosts(page, human, stats), false);
    assert.equal(clicks, 2, "must not keep clicking the same non-growing pill");
  } finally {
    Date.now = realNow;
  }
});

test("Grow invitation stack scrolls until a Connect card is visible", () => {
  const html = `<main>
    <div id="scroller">
      <div class="invite">
        <button aria-label="Ignore an invitation to connect from Ada">Ignore</button>
        <button aria-label="Ignore an invitation to connect from Bea">Ignore</button>
        <button aria-label="Ignore an invitation to connect from Cal">Ignore</button>
      </div>
      <div class="card">
        <a href="https://www.linkedin.com/in/dee">Dee Example</a>
        <button aria-label="Invite Dee Example to connect">Connect</button>
      </div>
    </div>
  </main>`;
  const { document } = parseHTML(html);
  const scroller = document.querySelector("#scroller");
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value) => { scrollTop = value; },
  });
  Object.defineProperty(scroller, "scrollHeight", { get: () => 1200 });
  Object.defineProperty(scroller, "clientHeight", { get: () => 400 });
  scroller.scrollBy = function scrollBy(_x, y) { this.scrollTop += y; };

  const ignoreButtons = [...document.querySelectorAll("button")].filter((b) => /Ignore/i.test(b.getAttribute("aria-label") || ""));
  const connectBtn = [...document.querySelectorAll("button")].find((b) => /Invite Dee/i.test(b.getAttribute("aria-label") || ""));
  const ignoreTops = [300, 424, 548];
  const placeButtons = () => {
    ignoreButtons.forEach((button, index) => {
      const top = ignoreTops[index] - scrollTop;
      button.getBoundingClientRect = () => ({ x: 300, y: top, top, bottom: top + 40, width: 120, height: 40 });
    });
    const top = 900 - scrollTop;
    connectBtn.getBoundingClientRect = () => ({ x: 300, y: top, top, bottom: top + 40, width: 120, height: 40 });
  };
  placeButtons();
  for (const el of document.querySelectorAll("a, main, div")) {
    if (!el.getBoundingClientRect) {
      el.getBoundingClientRect = () => ({ x: 300, y: 150, top: 150, bottom: 190, width: 120, height: 40 });
    }
  }
  const world = vm.runInNewContext(`(${networkDomWorld.toString()})()`, {
    document,
    location: { origin: "https://www.linkedin.com" },
    innerHeight: 900,
    getComputedStyle: (el) => (el === scroller
      ? { overflowY: "auto", overflow: "auto", visibility: "visible" }
      : { overflowY: "visible", overflow: "visible", visibility: "visible" }),
    URL,
    window: {
      scrollY: 0,
      scrollBy() {},
    },
  });
  // Keep button geometry in sync with scroller movement for this fixture.
  const originalScroll = world.scrollGrowTowardConnect.bind(world);
  world.scrollGrowTowardConnect = (input) => {
    const result = originalScroll(input);
    placeButtons();
    return { ...result, ...world.invitationOnlyViewport(), reveal: world.revealConnect() };
  };
  assert.equal(world.inspect().length, 0);
  assert.equal(world.invitationOnlyViewport().invitationOnly, true);
  let found = null;
  for (let pass = 0; pass < 4; pass += 1) {
    world.scrollGrowTowardConnect({ deltaY: 300 });
    placeButtons();
    found = world.inspect()[0] || null;
    if (found) break;
  }
  assert.ok(found, "expected a Connect card within a few grow scroll passes");
  assert.equal(found.url, "https://www.linkedin.com/in/dee");
});

test("Grow scroller that does not move exits early with an explicit reason", async () => {
  const previous = { ...config };
  try {
    config.connectionsEnabled = true;
    const html = `<main>
      <button aria-label="Ignore an invitation to connect from Ada">Ignore</button>
      <button aria-label="Ignore an invitation to connect from Bea">Ignore</button>
    </main>`;
    const { document, world } = domWorld(html);
    for (const button of document.querySelectorAll("button")) {
      button.getBoundingClientRect = () => ({ x: 300, y: 300, top: 300, bottom: 340, width: 120, height: 40 });
    }
    let url = "https://www.linkedin.com/mynetwork/grow/";
    const state = emptyState();
    beginRun(state, { testRun: false });
    const page = {
      url: () => url,
      goto: async (to) => { url = to; },
      evaluate: async (fn, ...args) => {
        if (args.length >= 2) {
          const method = args[1];
          const input = args[2];
          if (method === "scrollGrowTowardConnect") {
            return { moved: 0, connectFound: 0, invitationOnly: true, ignoreVisible: 2, reveal: { found: 0, scrolled: false } };
          }
          if (method === "invitationOnlyViewport") {
            return { invitationOnly: true, ignoreVisible: 2, connectFound: 0, connectVisible: 0 };
          }
          if (method === "revealConnect") return { scrolled: false, found: 0 };
          if (method === "myNetwork" || method === "growTab" || method === "morePeople") return null;
          if (typeof world[method] === "function") return world[method](input);
          return null;
        }
        if (typeof fn === "function") {
          try { return fn(); }
          catch { return { text: "", feedPresent: true, connectish: [], mainSample: [] }; }
        }
        return { text: "", feedPresent: true };
      },
      mouse: { move: async () => {}, click: async () => {}, wheel: async () => {} },
    };
    const result = await runConnectionBatch(page, state, {
      maxAttempts: 3,
      maxDurationMs: 60_000,
      pause: async () => {},
      gapRange: [0, 0],
    });
    assert.equal(result.connections, 0);
    assert.equal(result.attempted, 0);
    assert.match(result.reason || "", /invitation|scroller|Connect|suggestions/i);
  } finally {
    Object.assign(config, previous);
  }
});
