import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const root = mkdtempSync(join(tmpdir(), "warmup-follow-test-"));
process.env.WARMUP_DATA_DIR = root;
process.env.WARMUP_LOG_DIR = join(root, "logs");
process.env.GL_PROFILE_NAME = "Fixture";
process.env.GL_PROFILE_ID = "fixture-follow";
const { emptyState, loadState, scopedStatePath } = await import("../src/sessionState.js");
const { config, sampleFollowCap, sampleSessionPlan } = await import("../src/config.js");
const { reserveAction, finishAction, beginRun, weeklyBudget } = await import("../src/activity.js");
const { feedDomWorld, feedDomHelpers } = await import("../src/scenario/linkedinDom.js");
const { Optimizer } = await import("../src/optimizer/reviewer.js");
const { TrustedPointer } = await import("../src/human/trackpad.js");
const { controlNeedsFeedClamp } = await import("../src/human/input.js");
const { followPerson, maybeFollow } = await import("../src/scenario/linkedinFeed.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

function feedWorld(html, rects = {}) {
  const { document, window } = parseHTML(html);
  const defaultRect = { x: 300, y: 200, top: 200, bottom: 500, width: 540, height: 300, left: 300, right: 840 };
  for (const el of document.querySelectorAll("*")) {
    const key = el.getAttribute("componentkey") || el.id || el.getAttribute("data-rect") || "";
    const rect = rects[key] || defaultRect;
    el.getBoundingClientRect = () => ({ ...rect });
  }
  document.elementFromPoint = (x, y) => {
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll("button, [role='button'], a")) {
      const r = el.getBoundingClientRect();
      if (x < r.x || y < r.y || x > r.x + r.width || y > r.y + r.height) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
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
  const helpers = vm.runInNewContext(`(${feedDomHelpers.toString()})()`, sandbox);
  const world = vm.runInNewContext(`(${feedDomWorld.toString()})(helpers)`, { ...sandbox, helpers });
  return { document, world };
}

const box = (x, top, width, height) => ({ x, y: top, top, left: x, width, height, bottom: top + height, right: x + width });

// Mirrors the operator screenshot: Recommended for you module, a Suggested card
// with Follow, a card already showing Following, plus a company row and an ad.
const FEED = `<!doctype html><html><body><main id="workspace">
  <div data-testid="mainFeed" data-rect="feed" role="list">
    <div role="listitem" data-rect="rec">
      <h2>Recommended for you</h2>
      <div data-rect="row1"><a href="https://www.linkedin.com/in/ghazalalagh/?miniProfile=1">Ghazal Alagh</a> Chief Mama &amp; Co-founder
        <button data-rect="f1" aria-label="Follow Ghazal Alagh">+ Follow</button></div>
      <div data-rect="row2"><a href="/in/ankurwarikoo/">Ankur Warikoo</a> Founder @WebVeda
        <button data-rect="f2" aria-label="Follow Ankur Warikoo">+ Follow</button></div>
      <div data-rect="row3"><a href="/in/jaya-kishori/">Jaya Kishori</a> Motivational Speaker
        <button data-rect="f3">Follow</button></div>
      <div data-rect="row4"><a href="/company/findmyicp/">FindMyICP</a>
        <button data-rect="f5" aria-label="Follow FindMyICP">Follow</button></div>
      <button data-rect="showmore">Show more</button>
    </div>
    <div componentkey="update-card-suggested">
      <span>Suggested</span>
      <div data-rect="hdr1"><a href="/in/christian-meram/">Christian Meram</a> 3rd+ Co-Founder
        <button data-rect="f4" aria-label="Follow Christian Meram">Follow</button></div>
      <p>Speed in a startup is not about how much code you ship. It is about how fast you can see you were wrong.</p>
      <div>
        <button data-rect="like4" aria-label="Reaction button state: no reaction Like">Like</button>
        <button data-rect="comment4">Comment</button>
        <button data-rect="repost4">Repost</button>
        <button data-rect="send4">Send</button>
      </div>
    </div>
    <div componentkey="update-card-following">
      <div data-rect="hdr2"><a href="/in/anil-agarwal/">Anil Agarwal</a>
        <button data-rect="following" aria-label="Following Anil Agarwal">Following</button></div>
      <p>Agar aap sapne dekhoge nahi, toh sapne poore kaise honge?</p>
      <div>
        <button data-rect="like5" aria-label="Reaction button state: no reaction Like">Like</button>
        <button data-rect="comment5">Comment</button>
      </div>
    </div>
    <div componentkey="update-card-ad">
      <span>Promoted</span>
      <div data-rect="hdr3"><a href="/in/ad-person/">Ad Person</a>
        <button data-rect="f6">Follow</button></div>
      <div>
        <button data-rect="like6" aria-label="Reaction button state: no reaction Like">Like</button>
        <button data-rect="comment6">Comment</button>
      </div>
    </div>
  </div>
</main></body></html>`;

const RECTS = {
  feed: box(288, 0, 382, 3000),
  rec: box(288, 160, 382, 320),
  row1: box(288, 250, 382, 56), f1: box(598, 262, 60, 32),
  row2: box(288, 310, 382, 56), f2: box(598, 322, 60, 32),
  row3: box(288, 370, 382, 56), f3: box(598, 382, 60, 32),
  row4: box(288, 430, 382, 40), f5: box(598, 434, 60, 32),
  showmore: box(420, 470, 120, 30),
  "update-card-suggested": box(288, 490, 382, 280),
  hdr1: box(288, 510, 382, 50), f4: box(610, 516, 52, 28),
  like4: box(300, 720, 90, 36), comment4: box(400, 720, 90, 36), repost4: box(500, 720, 80, 36), send4: box(590, 720, 70, 36),
  "update-card-following": box(1000, 160, 382, 300),
  hdr2: box(1000, 170, 382, 50), following: box(1300, 176, 80, 28),
  like5: box(1010, 400, 90, 36), comment5: box(1110, 400, 90, 36),
  "update-card-ad": box(1500, 160, 382, 300),
  hdr3: box(1500, 170, 382, 50), f6: box(1800, 176, 60, 28),
  like6: box(1510, 400, 90, 36), comment6: box(1610, 400, 90, 36),
};

test("Recommended for you person rows and a Suggested card header Follow are recognized", () => {
  const { world } = feedWorld(FEED, RECTS);
  const found = world.followCandidates();
  const byUrl = Object.fromEntries(found.map((c) => [c.profileUrl, c]));
  assert.deepEqual(Object.keys(byUrl).sort(), [
    "https://www.linkedin.com/in/ankurwarikoo/",
    "https://www.linkedin.com/in/christian-meram/",
    "https://www.linkedin.com/in/ghazalalagh/",
    "https://www.linkedin.com/in/jaya-kishori/",
  ]);
  assert.equal(byUrl["https://www.linkedin.com/in/ghazalalagh/"].source, "recommended");
  assert.equal(byUrl["https://www.linkedin.com/in/jaya-kishori/"].source, "recommended");
  assert.equal(byUrl["https://www.linkedin.com/in/christian-meram/"].source, "suggested");
  const ghazal = byUrl["https://www.linkedin.com/in/ghazalalagh/"];
  assert.equal(world.probe(ghazal.x, ghazal.y, "follow", ghazal.profileUrl).safe, true);
  assert.equal(world.probe(ghazal.x, ghazal.y, "follow", "https://www.linkedin.com/in/ankurwarikoo/").reason, "different-person");
  assert.ok(world.locateFollow("https://www.linkedin.com/in/christian-meram/"));
});

test("Following, company rows, ads, and Show more are never Follow targets", () => {
  const { world } = feedWorld(FEED, RECTS);
  const urls = world.followCandidates().map((c) => c.profileUrl);
  assert.ok(!urls.includes("https://www.linkedin.com/in/anil-agarwal/"));
  assert.ok(!urls.includes("https://www.linkedin.com/in/ad-person/"));
  assert.ok(!urls.some((u) => /findmyicp/.test(u)));
  const following = RECTS.following;
  assert.equal(world.probe(following.x + 10, following.y + 10, "follow", "https://www.linkedin.com/in/anil-agarwal/").safe, false);
  assert.equal(world.followState("https://www.linkedin.com/in/anil-agarwal/"), "following");
  assert.equal(world.followState("https://www.linkedin.com/in/ghazalalagh/"), "follow");
  const more = RECTS.showmore;
  assert.equal(world.probe(more.x + 10, more.y + 10, "follow", "https://www.linkedin.com/in/ghazalalagh/").reason, "not-follow-button");
});

test("Like and Comment buttons are not treated as Follow", () => {
  const { world } = feedWorld(FEED, RECTS);
  for (const key of ["like4", "comment4", "repost4", "send4"]) {
    const r = RECTS[key];
    const probe = world.probe(r.x + 10, r.y + 10, "follow", "https://www.linkedin.com/in/christian-meram/");
    assert.equal(probe.safe, false, key);
    assert.equal(probe.reason, "not-follow-button", key);
  }
  assert.ok(world.followCandidates().every((c) => !/like|comment/i.test(c.label)));
  // The Like probe still refuses the Follow button, so the two paths stay separate.
  const f4 = RECTS.f4;
  assert.equal(world.probe(f4.x + 10, f4.y + 10, "like").safe, false);
});

test("the session follow cap is usually 0, sometimes 1, rarely 2, never above 2", () => {
  assert.equal(sampleFollowCap(0), 0);
  assert.equal(sampleFollowCap(0.71), 0);
  assert.equal(sampleFollowCap(0.8), 1);
  assert.equal(sampleFollowCap(0.96), 2);
  assert.equal(sampleFollowCap(0.9999), 2);
  const counts = [0, 0, 0];
  for (let i = 0; i < 4000; i += 1) counts[sampleSessionPlan().followCap] += 1;
  assert.equal(counts.length, 3);
  assert.ok(counts[0] / 4000 > 0.6, `zero-follow sessions ${counts[0]}`);
  assert.ok(counts[2] < counts[1]);
});

test("the follow gate usually declines and enforces caps, module skip, and one Recommended follow", () => {
  const optimizer = new Optimizer(emptyState());
  const candidate = { profileUrl: "https://www.linkedin.com/in/ghazalalagh/", source: "recommended" };
  const timing = { elapsedMs: 10 * 60_000, remainingMs: 5 * 60_000 };
  let allowed = 0;
  const trials = 4000;
  for (let i = 0; i < trials; i += 1) {
    optimizer.plan = sampleSessionPlan();
    if (optimizer.gateFollow({ candidate, stats: { followAttempts: 0 }, ...timing }).allow) allowed += 1;
  }
  assert.ok(allowed / trials < 0.1, `allowed ${allowed}/${trials}`);

  optimizer.plan = { followCap: 2, followRecommended: true, warmupMs: 0, windDownMs: 0, minMsBetweenFollows: 0 };
  assert.equal(optimizer.gateFollow({ candidate, stats: {}, ...timing, roll: 0.99 }).allow, false);
  assert.equal(optimizer.gateFollow({ candidate, stats: {}, ...timing, roll: 0 }).allow, true);
  assert.match(optimizer.gateFollow({ candidate, stats: { followAttempts: 2 }, ...timing, roll: 0 }).reason, /cap/);
  assert.match(optimizer.gateFollow({ candidate, stats: { recommendedFollows: 1 }, ...timing, roll: 0 }).reason, /Recommended/);
  assert.match(optimizer.gateFollow({ candidate: { profileUrl: "https://www.linkedin.com/company/x/", source: "suggested" }, stats: {}, ...timing, roll: 0 }).reason, /person/);
  optimizer.plan = { ...optimizer.plan, followCap: 9 };
  assert.match(optimizer.gateFollow({ candidate: { ...candidate, source: "suggested" }, stats: { followAttempts: 2 }, ...timing, roll: 0 }).reason, /cap/);
  optimizer.plan = { ...optimizer.plan, followRecommended: false };
  assert.match(optimizer.gateFollow({ candidate, stats: {}, ...timing, roll: 0 }).reason, /skipped/);
});

test("test runs never follow", () => {
  const previous = { ...config };
  try {
    config.testRun = true;
    const preflight = new Optimizer(emptyState()).preflight();
    assert.equal(preflight.plan.followCap, 0);
  } finally { Object.assign(config, previous); }
});

test("follow reservations dedupe by profile URL, cap at 2 per run, and never touch the connection budget", () => {
  const now = new Date("2026-09-14T06:00:00Z");
  const state = emptyState();
  state.enrolledAt = now.toISOString();
  weeklyBudget(state, now, () => 40);
  beginRun(state, { testRun: false }, now, () => {});
  const persist = () => {};
  const a = reserveAction(state, "follow", "https://www.linkedin.com/in/a/", { now, persist, limit: 2 });
  assert.ok(a);
  assert.equal(reserveAction(state, "follow", "https://www.linkedin.com/in/a/", { now, persist, limit: 2 }), null);
  const b = reserveAction(state, "follow", "https://www.linkedin.com/in/b/", { now, persist, limit: 2 });
  assert.ok(b);
  assert.equal(reserveAction(state, "follow", "https://www.linkedin.com/in/c/", { now, persist, limit: 2 }), null);
  finishAction(state, a, true, persist);
  finishAction(state, b, false, persist);
  const week = Object.values(state.weekly)[0];
  assert.equal(week.used, 0);
  assert.equal(Object.values(state.daily)[0].connections, 0);
  assert.equal(Object.values(state.daily)[0].follows, 2);
});

test("saved follow actions load, and old state files without follow counters still load", () => {
  const path = scopedStatePath();
  const old = emptyState();
  old.daily["2026-09-14"] = { likes: 1, sessions: 1, postsSeen: 10, aborted: 0 };
  old.actions.push({ id: "x", runId: "r", key: "k", kind: "like", at: "2026-09-14T06:00:00Z", status: "confirmed" });
  writeFileSync(path, JSON.stringify(old));
  assert.equal(loadState().daily["2026-09-14"].likes, 1);
  old.daily["2026-09-14"].follows = 1;
  old.actions.push({ id: "y", runId: "r", key: "k2", kind: "follow", at: "2026-09-14T06:10:00Z", status: "unconfirmed" });
  writeFileSync(path, JSON.stringify(old));
  assert.equal(loadState().actions.at(-1).kind, "follow");
  old.daily["2026-09-14"].follows = -1;
  writeFileSync(path, JSON.stringify(old));
  assert.throws(() => loadState(), /follows/);
});

test("single-press follow click never re-sends a timed-out mousePressed", async () => {
  const sent = [];
  const page = {
    bringToFront: async () => {},
    createCDPSession: async () => ({
      send: (method, params) => {
        sent.push(params.type);
        return params.type === "mousePressed" ? new Promise(() => {}) : Promise.resolve();
      },
      detach: async () => {},
    }),
  };
  const pointer = new TrustedPointer(page, { commandTimeoutMs: 30 });
  await assert.rejects(() => pointer.click({ singlePress: true }), /timed out/);
  assert.equal(sent.filter((t) => t === "mousePressed").length, 1);
  assert.equal(sent.filter((t) => t === "mouseReleased").length, 1);
  assert.equal(controlNeedsFeedClamp("follow"), false);
});

function fakePage(answers) {
  return {
    keyboard: { press: async () => {} },
    evaluate: async (_fn, _world, _helpers, name) => answers[name]?.(),
  };
}

test("a failed Follow hit check is not re-hovered or clicked again", async () => {
  let reveals = 0;
  let clicks = 0;
  const human = {
    revealControl: async () => { reveals += 1; return { x: 620, y: 280 }; },
    clickAt: async (_x, _y, kind, urn, options) => {
      clicks += 1;
      assert.equal(kind, "follow");
      assert.equal(urn, "https://www.linkedin.com/in/ghazalalagh/");
      assert.equal(options.singlePress, true);
      return false;
    },
  };
  const page = fakePage({ dialogOpen: () => false, followState: () => "follow" });
  const ok = await followPerson(page, human, { profileUrl: "https://www.linkedin.com/in/ghazalalagh/", source: "recommended" });
  assert.equal(ok, false);
  assert.equal(reveals, 1);
  assert.equal(clicks, 1);
});

test("each person gets one roll per session and the run stops at the hard cap", async () => {
  const candidates = [
    { profileUrl: "https://www.linkedin.com/in/a/", source: "recommended" },
    { profileUrl: "https://www.linkedin.com/in/b/", source: "suggested" },
    { profileUrl: "https://www.linkedin.com/in/c/", source: "suggested" },
  ];
  const rolled = [];
  const optimizer = {
    plan: { followCap: 2 },
    gateFollow: ({ candidate }) => { rolled.push(candidate.profileUrl); return { allow: false, reason: "no" }; },
  };
  const page = fakePage({ followCandidates: () => candidates });
  const stats = { followAttempts: 0, follows: 0, recommendedFollows: 0 };
  const considered = new Set();
  for (let i = 0; i < 10; i += 1) await maybeFollow(page, {}, optimizer, stats, { started: 0, endsAt: Date.now() + 60_000, considered });
  assert.equal(rolled.length, 3);
  assert.equal(new Set(rolled).size, 3);

  optimizer.gateFollow = () => { throw new Error("gate must not run past the cap"); };
  await maybeFollow(page, {}, optimizer, { followAttempts: 2 }, { started: 0, endsAt: Date.now() + 60_000, considered: new Set() });
});
