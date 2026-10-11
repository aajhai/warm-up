import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const root = mkdtempSync(join(tmpdir(), "warmup-explore-test-"));
process.env.WARMUP_DATA_DIR = root;
process.env.WARMUP_LOG_DIR = join(root, "logs");
process.env.GL_PROFILE_NAME = "Fixture";
process.env.GL_PROFILE_ID = "fixture-explore";
process.env.CONNECTIONS_ENABLED = "true";
const { emptyState, loadState, scopedStatePath } = await import("../src/sessionState.js");
const { config, sampleFlow, sampleGrowInvites, sampleSessionPlan } = await import("../src/config.js");
const { beginRun, weeklyBudget, reserveAction, rememberVisit, alreadyVisited, utcWeekKey, hasUncertainConnect, recoverInterruptedRun } = await import("../src/activity.js");
const { accountSnapshotWorld, classifyAccount, inspectAccount } = await import("../src/scenario/accountGuard.js");
const { inviteHoldReason, recordStillOffered, recordInviteLimit, nextIstMidnight, nextWeeklyReset } = await import("../src/inviteHold.js");
const { networkDomWorld, runConnectionBatch, pickGrowCandidate, scrollsBetweenInvites, leftMyNetwork, settleGrow, GROW_SETTLE_MS } = await import("../src/scenario/linkedinNetwork.js");
const { profileDomWorld, readProfilePage, pickSearchQuery, rememberQuery, pickResultIndex, runSearch, profileConnect, normalizeQuery, visitCompanyFromProfile, verifyNeeds } = await import("../src/scenario/linkedinProfile.js");
const { feedDomWorld, feedDomHelpers } = await import("../src/scenario/linkedinDom.js");
const { Optimizer } = await import("../src/optimizer/reviewer.js");
const { runPlannedSteps, postInviteDwell, postInviteDwellMs } = await import("../src/runner.js");
const { maybeVisitFromFeed } = await import("../src/scenario/linkedinFeed.js");
const { logFile } = await import("../src/logger.js");

const repo = fileURLToPath(new URL("..", import.meta.url));
test.after(() => rmSync(root, { recursive: true, force: true }));

const box = (x, top, width, height) => ({ x, y: top, top, left: x, width, height, bottom: top + height, right: x + width });
const fakeShared = () => ({ day: { queries: [], stillOffered: [] }, save() {} });
const noPause = async () => {};

function productionState() {
  const state = emptyState();
  state.enrolledAt = new Date(Date.now() - 30 * 86400_000).toISOString();
  beginRun(state, { testRun: false }, new Date(), () => {});
  return state;
}

function networkWorld(html) {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll("*")) {
    el.getBoundingClientRect = () => ({ x: 300, y: 150, top: 150, bottom: 190, width: 120, height: 40 });
  }
  const world = vm.runInNewContext(`(${networkDomWorld.toString()})()`, { document, location: { origin: "https://www.linkedin.com" }, innerHeight: 900, getComputedStyle: () => ({ visibility: "visible" }), URL });
  return { document, world };
}

function growPage(world, { onClick = () => {}, onReload = () => {} } = {}) {
  const calls = { clicks: 0, reloads: 0, wheels: 0 };
  const page = {
    url: () => "https://www.linkedin.com/mynetwork/grow/",
    goto: async () => {},
    reload: async () => { calls.reloads += 1; onReload(); },
    evaluate: async (fn, ...args) => (args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true }),
    mouse: {
      move: async () => {},
      click: async () => { calls.clicks += 1; onClick(); },
      wheel: async () => { calls.wheels += 1; },
    },
  };
  return { page, calls };
}

const firstCard = (list) => ({ candidate: list[0] || null, skipped: [] });
const TWO_CARDS = '<main><li id="amy"><a href="https://www.linkedin.com/in/amy">Amy Example</a><button>Connect</button></li><li id="ben"><a href="https://www.linkedin.com/in/ben">Ben Example</a><button>Connect</button></li></main>';

test("Grow candidate selection is not first-visible-unused", () => {
  const cards = ["a", "b", "c", "d"].map((id) => ({ url: `https://www.linkedin.com/in/${id}`, name: id }));
  const counts = { a: 0, b: 0, c: 0, d: 0 };
  let skippedSome = 0;
  for (let i = 0; i < 4000; i += 1) {
    const { candidate, skipped } = pickGrowCandidate(cards, { state: emptyState() });
    counts[candidate.name] += 1;
    if (skipped.length) skippedSome += 1;
    assert.ok(!skipped.some((s) => s.url === candidate.url));
  }
  assert.ok(counts.a / 4000 < 0.4, `first card chosen ${counts.a}/4000`);
  for (const key of Object.keys(counts)) assert.ok(counts[key] > 400, `${key} chosen ${counts[key]}`);
  assert.ok(skippedSome > 800, "some cards are passed over");
  const state = productionState();
  weeklyBudget(state);
  reserveAction(state, "connect", cards[0].url, { limit: 4, persist: () => {} });
  const passed = new Set([cards[1].url, cards[2].url]);
  assert.equal(pickGrowCandidate(cards, { state, passed }).candidate.url, cards[3].url);
  assert.equal(pickGrowCandidate(cards.slice(0, 3), { state, passed }).candidate, null);
});

test("invite count ceiling is 8, zero is the most common draw, and invites are split by scrolls", () => {
  assert.equal(sampleGrowInvites(0), 0);
  assert.equal(sampleGrowInvites(0.9999), 8);
  const counts = Array.from({ length: 9 }, () => 0);
  for (let i = 0; i < 8000; i += 1) counts[sampleGrowInvites()] += 1;
  assert.ok(counts[0] === Math.max(...counts), `zero should be most common: ${counts}`);
  assert.ok(counts[8] > 0 && counts[1] > counts[8], `ceiling 8 is rare: ${counts}`);
  assert.equal(scrollsBetweenInvites(() => 0), 1);
  assert.equal(scrollsBetweenInvites(() => 0.5), 2);
  assert.equal(scrollsBetweenInvites(() => 0.9), 3);
});

test("session flow is the feed, then My Network only when an invitation was drawn", () => {
  let withGrow = 0;
  let feedOnly = 0;
  for (let i = 0; i < 4000; i += 1) {
    const flow = sampleFlow();
    assert.equal(flow.search, false);
    assert.equal(flow.searchCompany, false);
    assert.equal(flow.searchConnect, false);
    assert.equal(flow.feedVisits, 0);
    assert.equal(flow.growVisits, 0);
    assert.ok(flow.inviteCount <= 8);
    assert.ok(flow.order[0] === "feed");
    if (flow.inviteCount > 0) {
      assert.deepEqual(flow.order, ["feed", "grow"]);
      withGrow += 1;
    } else {
      assert.deepEqual(flow.order, ["feed"]);
      feedOnly += 1;
    }
  }
  assert.ok(withGrow > 0 && feedOnly > 0, `grow ${withGrow} feed-only ${feedOnly}`);
});

test("test runs and connection trials never search, connect, follow, or view profiles", async () => {
  const previous = { ...config };
  try {
    config.testRun = true;
    const plan = new Optimizer(emptyState()).preflight().plan;
    assert.deepEqual(plan.order, ["feed"]);
    assert.equal(plan.search, false);
    assert.equal(plan.searchConnect, false);
    assert.equal(plan.inviteCount, 0);
    assert.equal(plan.followCap, 0);
    assert.equal(plan.feedVisits + plan.growVisits, 0);
    Object.assign(config, { testRun: false, connectionTrial: true });
    const trial = new Optimizer(emptyState()).preflight().plan;
    assert.equal(trial.search, false);
    assert.equal(trial.inviteCount, 1);
  } finally { Object.assign(config, previous); }

  const explode = { url: () => { throw new Error("page touched"); }, evaluate: async () => { throw new Error("page touched"); } };
  const state = emptyState();
  beginRun(state, { testRun: true }, new Date(), () => {});
  assert.match((await runSearch(explode, state, { search: true, testRun: true })).reason, /not planned/);
  const grow = await runConnectionBatch(explode, state, { maxAttempts: 3, growVisits: 2 });
  assert.equal(grow.attempted, 0);
  const called = [];
  const result = await runPlannedSteps(explode, state, { order: ["search", "feed", "grow"], search: true, testRun: true, sessionMs: 600_000 }, null, {
    steps: {
      feed: async () => { called.push("feed"); return { likes: 0, postsSeen: 9, aborted: false }; },
      search: async () => { called.push("search"); return {}; },
      grow: async () => { called.push("grow"); return {}; },
    },
  });
  assert.deepEqual(called, ["feed"]);
  assert.equal(result.connections, 0);
});

test("planned steps run in the sampled order and a search before the feed shortens it", async () => {
  const called = [];
  let feedMs = null;
  const dwells = [];
  const steps = {
    feed: async (_p, plan) => { called.push("feed"); feedMs = plan.sessionMs; return { likes: 0, postsSeen: 9, aborted: false }; },
    search: async () => { called.push("search"); return { query: "aman sharma", visits: 1, attempted: 0, connections: 0, sent: [] }; },
    grow: async (_p, _s, opts) => {
      called.push(`grow:${opts.maxAttempts}:${opts.growVisits}`);
      return opts.maxAttempts ? { connections: 1, attempted: 1, visits: 1, sent: [{ confirmed: true }] } : { connections: 0, attempted: 0, visits: 1, sent: [] };
    },
    dwell: async (_p, ms) => { dwells.push(ms); },
  };
  const result = await runPlannedSteps({}, emptyState(), { order: ["search", "feed", "grow"], search: true, inviteCount: 2, growVisits: 1, sessionMs: 600_000 }, null, { steps });
  assert.deepEqual(called, ["feed", "grow:2:1"]);
  assert.equal(feedMs, 600_000);
  assert.equal(result.visits, 1);
  assert.equal(result.connections, 1);
  assert.equal(dwells.length, 1);
  called.length = 0;
  await runPlannedSteps({}, emptyState(), { order: ["feed", "grow"], search: false, inviteCount: 0, growVisits: 1, sessionMs: 600_000 }, null, { steps });
  assert.deepEqual(called, ["feed", "grow:0:1"]);
  assert.equal(dwells.length, 1, "no invite, no dwell");
});

test("post-invite dwell is scheduled only when an invite was sent, for 60-180s, with heartbeats", async () => {
  const at = Date.now();
  assert.equal(postInviteDwellMs({ sent: [], lastInviteAt: at, now: at }), 0);
  assert.equal(postInviteDwellMs({ sent: [{ confirmed: false, notSent: true }], lastInviteAt: at, now: at }), 0, "a press that never went out is not an invite");
  assert.equal(postInviteDwellMs({ sent: [{ confirmed: true }], lastInviteAt: null, now: at }), 0);
  for (const roll of [0, 0.5, 0.999]) {
    const ms = postInviteDwellMs({ sent: [{ confirmed: true }], lastInviteAt: at, now: at, rng: () => roll });
    assert.ok(ms >= 60_000 && ms <= 180_000, `dwell ${ms}`);
  }
  assert.equal(postInviteDwellMs({ sent: [{ confirmed: true }], lastInviteAt: at - 200_000, now: at }), 0, "time since the invite already covers it");
  assert.ok(postInviteDwellMs({ sent: [{ confirmed: false }], lastInviteAt: at, now: at }) >= 60_000, "an uncertain press still dwells");

  let beats = 0;
  let paused = 0;
  const scrolls = [];
  const waited = await postInviteDwell({}, 90_000, { onHeartbeat: () => { beats += 1; }, pause: async (ms) => { paused += ms; }, rng: () => 0.1, scroll: async (dy) => { scrolls.push(dy); } });
  assert.equal(waited, 90_000);
  assert.equal(paused, 90_000);
  assert.ok(beats >= 90, "a heartbeat at least every second keeps the 60s watchdog quiet");
  assert.ok(scrolls.length >= 1 && scrolls.every((dy) => Math.abs(dy) <= 320), "only small scrolls");

  const controller = new AbortController();
  let slices = 0;
  const cut = await postInviteDwell({}, 120_000, { signal: controller.signal, pause: async () => { if (++slices === 5) controller.abort(); }, scroll: async () => {} });
  assert.equal(cut, 5_000, "a cancelled session stops dwelling");

  const dwells = [];
  const base = {
    feed: async () => ({ likes: 0, postsSeen: 9, aborted: false }),
    search: async () => ({ visits: 1, attempted: 1, connections: 1, sent: [{ confirmed: true }] }),
    grow: async () => ({ connections: 1, attempted: 1, sent: [{ confirmed: true }] }),
    dwell: async (_p, ms) => { dwells.push(ms); },
  };
  await runPlannedSteps({}, emptyState(), { order: ["feed", "grow"], inviteCount: 1, sessionMs: 600_000 }, null, { steps: base });
  assert.equal(dwells.length, 1, "a My Network invite dwells");
  await runPlannedSteps({}, emptyState(), { order: ["feed", "search"], search: true, sessionMs: 600_000 }, null, { steps: base });
  assert.equal(dwells.length, 1, "search does not run, so a profile invite is not sent");
  await runPlannedSteps({}, emptyState(), { order: ["feed", "grow"], inviteCount: 1, sessionMs: 600_000 }, null, { steps: { ...base, grow: async () => ({ connections: 1, attempted: 1, sent: [{ confirmed: true }], accountBlock: { kind: "checkpoint", reason: "checkpoint" } }) } });
  assert.equal(dwells.length, 1, "no lingering on a checkpoint");
  await runPlannedSteps({}, emptyState(), { order: ["feed"], inviteCount: 0, sessionMs: 600_000 }, null, { steps: base });
  assert.equal(dwells.length, 1, "zero invites, no dwell");
});

test("search queries are full names, never repeated for the profile, and avoid today's shared list", () => {
  const state = emptyState();
  const shared = fakeShared();
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const query = pickSearchQuery(state, shared);
    assert.match(query, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.ok(!seen.has(normalizeQuery(query)), `repeated ${query}`);
    seen.add(normalizeQuery(query));
    rememberQuery(state, query, null, () => {});
  }
  const other = fakeShared();
  other.day.queries.push("aman sharma");
  for (let i = 0; i < 500; i += 1) assert.notEqual(normalizeQuery(pickSearchQuery(emptyState(), other, () => 0)), "aman sharma");
  const full = emptyState();
  const almost = [];
  const first = pickSearchQuery(full, null, () => 0);
  full.searchQueries = [normalizeQuery(first)];
  assert.notEqual(normalizeQuery(pickSearchQuery(full, null, () => 0)), normalizeQuery(first));
  almost.length = 0;
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < 4000; i += 1) counts[pickResultIndex(5)] += 1;
  assert.ok(counts[0] / 4000 < 0.35, `first result ${counts[0]}`);
  assert.ok(counts.every((c) => c > 200));
  assert.equal(pickResultIndex(1), 0);
});

// Models the header box value, the results URL built from it on Enter, and a typeahead that
// can stay open after submit. `ignoreSelectAll` mirrors Orbita, where Meta+A did not select.
function searchPage({ answers = {}, enterTab = "all", startUrl = "https://www.linkedin.com/feed/", startValue = "", typeaheadAfterEnter = 0, backspaceWorks = true, selectWorks = false, refillWith = null, seeAllWorks = false } = {}) {
  const calls = { typed: [], gotos: 0, clicks: [], keys: [], submitted: [], reloads: 0, backs: 0 };
  let url = startUrl;
  let value = startValue;
  let typeaheadOpen = 0;
  let selected = false;
  const results = ["p1", "p2", "p3", "p4", "p5"].map((slug, i) => ({ url: `https://www.linkedin.com/in/${slug}/`, name: `Person ${i}`, x: 400, y: 220 + i * 90, top: 200 + i * 90 }));
  const filter = { x: 610, y: 90 };
  const home = { x: 40, y: 20 };
  const keywords = () => new URL(url).searchParams.get("keywords") || "";
  const world = {
    searchBox: () => ({ kind: "input", value, x: 500, y: 30 }),
    probeSearchBox: () => true,
    searchFocused: () => true,
    searchValue: () => value,
    selectSearchText: () => { selected = selectWorks && value.length > 0; return selected; },
    typeahead: () => ({ open: typeaheadOpen > 0, panels: typeaheadOpen > 0 ? 1 : 0, seeAll: typeaheadOpen > 0 ? { x: 320, y: 136 } : null }),
    probeSeeAll: () => true,
    peopleFilter: () => filter,
    resultsCapture: () => ({ iframeCount: 0, shadowRootCount: 0, doc: { a: 3, button: 3, roleButton: 0, roleTab: 0 }, shadow: { a: 0, button: 0, roleButton: 0, roleTab: 0 }, visibleLabels: ["doc:button:People"], peopleMentions: [], people: { ...filter, where: "doc", label: "People", href: "" } }),
    probePeopleFilter: () => true,
    peopleResults: () => results,
    probeLink: () => true,
    homeLink: () => (url.startsWith("chrome-error") ? null : home),
    probeHome: () => true,
    ...answers,
  };
  let pointer = null;
  const page = {
    url: () => url,
    setUrl: (to) => { url = to; },
    value: () => value,
    goto: async () => { calls.gotos += 1; throw new Error("net::ERR_TUNNEL_CONNECTION_FAILED"); },
    goBack: async () => { calls.backs += 1; throw new Error("Browser Back is never used"); },
    reload: async () => { calls.reloads += 1; if (url.startsWith("chrome-error")) url = "https://www.linkedin.com/feed/"; },
    evaluate: async (fn, ...args) => (args.length ? world[args[1]]?.(args[2]) : { text: "", feedPresent: true }),
    keyboard: {
      type: async (ch) => {
        calls.typed.push(ch);
        value = refillWith && calls.typed.length === 1 ? `${refillWith}${ch}` : value + ch;
      },
      press: async (key) => {
        calls.keys.push(key);
        if (key === "Backspace" && selected) { value = ""; selected = false; }
        else if (key === "Backspace" && backspaceWorks) value = value.slice(0, -1);
        if (key === "Escape" && typeaheadOpen > 0) typeaheadOpen -= 1;
        if (key === "Enter") calls.submitted.push(value);
        if (key === "Enter" && enterTab) {
          url = `https://www.linkedin.com/search/results/${enterTab}/?keywords=${encodeURIComponent(value)}`;
          typeaheadOpen = typeaheadAfterEnter;
        } else if (key === "Enter" && typeaheadAfterEnter) typeaheadOpen = typeaheadAfterEnter;
      },
      down: async () => {}, up: async () => {},
    },
    mouse: {
      move: async (x, y) => { pointer = { x, y }; },
      click: async () => {
        calls.clicks.push({ ...pointer, url, typeaheadOpen: typeaheadOpen > 0 });
        if (pointer?.x === home.x && pointer?.y === home.y) { calls.homes = (calls.homes || 0) + 1; url = "https://www.linkedin.com/feed/"; return; }
        if (seeAllWorks && typeaheadOpen > 0 && pointer?.x === 320 && pointer?.y === 136) {
          url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(value)}`;
          typeaheadOpen = 0;
          return;
        }
        if (pointer?.x === filter.x && pointer?.y === filter.y) url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords())}`;
        const hit = results.find((r) => r.x === pointer?.x && r.y === pointer?.y);
        if (hit && /\/search\/results\/people\//.test(url)) url = hit.url;
      },
      wheel: async () => {},
    },
  };
  return { page, calls };
}

test("a search clears leftover text, submits exactly one query, closes the typeahead, and never clicks through it", async () => {
  const { page, calls } = searchPage({
    startUrl: "https://www.linkedin.com/search/results/people/?keywords=Naveen%20Bansal",
    startValue: "Naveen Bansal",
    enterTab: "people",
    typeaheadAfterEnter: 1,
  });
  const state = productionState();
  const reads = [];
  const out = await runSearch(page, state, { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { reads.push(page.url()); } });
  assert.equal(calls.submitted.length, 1, "one query per search step");
  assert.equal(calls.submitted[0], out.query, "box held exactly the new query, no leftover text");
  assert.ok(!calls.keys.includes("KeyA"), "no Meta+A select-all");
  const escapeAt = calls.keys.lastIndexOf("Escape");
  assert.ok(escapeAt > calls.keys.indexOf("Enter"), "Escape after submit");
  assert.ok(calls.clicks.length >= 1);
  assert.ok(calls.clicks.every((c) => !c.typeaheadOpen), "no click while the typeahead is open");
  assert.equal(out.visits, 1);
  assert.equal(reads.length, 1);
  assert.equal(calls.gotos, 0);

  const stuck = searchPage({ enterTab: "people", typeaheadAfterEnter: 99 });
  const skipped = await runSearch(stuck.page, productionState(), { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { throw new Error("no profile through a dimmed page"); } });
  assert.match(skipped.reason, /Typeahead/);
  assert.equal(skipped.accountBlock, null);
  const pastBox = stuck.calls.clicks.filter((c) => c.x !== 500);
  assert.deepEqual(pastBox.map((c) => c.x), [320], "after the header box, only the one See all results press");

  const stale = searchPage({ startUrl: "https://www.linkedin.com/search/results/people/?keywords=Naveen%20Bansal", startValue: "Naveen Bansal", enterTab: null });
  const noSubmit = await runSearch(stale.page, productionState(), { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { throw new Error("stale results are not this query"); } });
  assert.equal(noSubmit.visits, 0, "a tab already on an older search does not count as results");
  assert.match(noSubmit.reason, /did not open/);

  const sticky = searchPage({ startValue: "Naveen Bansal", backspaceWorks: false });
  const refused = await runSearch(sticky.page, productionState(), { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { throw new Error("no profile"); } });
  assert.equal(sticky.calls.typed.length, 0, "nothing typed into a box that would not empty");
  assert.equal(sticky.calls.submitted.length, 0);
  assert.equal(refused.accountBlock, null);
});

test("search types into the header box, opens People (not All), opens one of the first results, and never repeats", async () => {
  const { page, calls } = searchPage();
  const typed = calls.typed;
  const state = productionState();
  const reads = [];
  const plan = { search: true, searchConnect: false, searchCompany: false };
  const first = await runSearch(page, state, plan, { pause: noPause, shared: fakeShared(), read: async () => { reads.push(page.url()); } });
  assert.equal(first.searched, true);
  assert.equal(first.visits, 1);
  assert.equal(typed.join(""), first.query);
  assert.equal(calls.gotos, 0, "search never uses page.goto");
  assert.ok(calls.clicks.some((c) => /\/search\/results\/all\//.test(c.url) && c.x === 610), "People filter pressed from the All tab");
  assert.match(reads[0], /^https:\/\/www\.linkedin\.com\/in\//);
  assert.deepEqual(state.searchQueries, [normalizeQuery(first.query)]);
  assert.ok(alreadyVisited(state, reads[0]));
  typed.length = 0;
  page.setUrl("https://www.linkedin.com/feed/");
  const second = await runSearch(page, state, plan, { pause: noPause, shared: fakeShared(), read: async () => { reads.push(page.url()); } });
  assert.notEqual(normalizeQuery(second.query), normalizeQuery(first.query));
  assert.notEqual(reads[1], reads[0], "the same profile is never opened twice");
});

test("search never calls page.goto, and a missed search is skipped without pausing", async () => {
  const cases = [
    { name: "no search box", answers: { searchBox: () => null } },
    { name: "box never focuses", answers: { searchFocused: () => false } },
    { name: "Enter does not open results", enterTab: null },
    { name: "no People filter", answers: { resultsCapture: () => ({ iframeCount: 3, shadowRootCount: 0, visibleLabels: [], peopleMentions: [], people: null }) } },
  ];
  for (const { name, answers, enterTab } of cases) {
    const { page, calls } = searchPage({ answers, ...(enterTab === undefined ? {} : { enterTab }) });
    const state = productionState();
    const out = await runSearch(page, state, { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { throw new Error("no profile should open"); } });
    assert.equal(calls.gotos, 0, `${name}: no goto`);
    assert.equal(out.accountBlock, null, `${name}: no account block`);
    assert.equal(out.visits, 0, name);
    assert.ok(out.reason, name);
    assert.equal(state.pause, null, name);
  }

  const steps = {
    feed: async () => ({ likes: 0, postsSeen: 9, aborted: false }),
    search: async () => { throw new Error("Search box not found"); },
  };
  const state = productionState();
  const result = await runPlannedSteps({}, state, { order: ["feed", "search"], search: true, sessionMs: 600_000 }, null, { steps });
  assert.equal(result.aborted, false);
  assert.equal(result.accountBlock, undefined);
  assert.equal(state.pause, null);
  const source = readFileSync(join(repo, "src/scenario/linkedinProfile.js"), "utf8");
  assert.ok(!/goto\([^)]*search\/results/.test(source), "no goto to /search/results/");
});

test("the All-results capture waits with heartbeats, writes a click-free dump, and skips without clicking when no People control is found", async () => {
  const { page, calls } = searchPage({ answers: { resultsCapture: () => ({ iframeCount: 3, shadowRootCount: 0, doc: { a: 0, button: 0, roleButton: 0, roleTab: 0 }, shadow: { a: 0, button: 0, roleButton: 0, roleTab: 0 }, visibleLabels: [], peopleMentions: [], people: null }) } });
  let beats = 0;
  const out = await runSearch(page, productionState(), { search: true }, { pause: noPause, shared: fakeShared(), onHeartbeat: () => { beats += 1; }, read: async () => { throw new Error("no profile should open"); } });
  assert.equal(out.reason, "No People control in results capture");
  assert.ok(beats >= 22, "heartbeat through the ~15s wait");
  assert.equal(calls.gotos, 0);
  assert.ok(!calls.clicks.some((c) => /\/search\/results\/all\//.test(c.url)), "nothing on the results page is clicked");
  const dump = JSON.parse(readFileSync(out.dump, "utf8"));
  assert.equal(dump.iframeCount, 3);
  assert.equal(dump.people, null);
  assert.ok(!out.dump.startsWith(join(repo, "logs")), "tests never write into the repo logs");
});

test("the results capture counts document and shadow controls, samples labels, and only qualifies People for the same keywords", () => {
  const href = "https://www.linkedin.com/search/results/all/?keywords=Divya%20Saxena&origin=GLOBAL_SEARCH_HEADER&sid=secret";
  const { document, world } = profileWorld('<main><iframe src="https://www.linkedin.com/preload/?token=abc"></iframe><a href="/search/results/people/?keywords=Someone%20Else">People</a><a href="/in/divya/">Divya Saxena</a><div id="host"></div></main><input value="typed secret">', { href });
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = '<a href="/search/results/people/?keywords=Divya%20Saxena&sid=x">People</a>';
  root.querySelector("a").getBoundingClientRect = () => ({ x: 300, y: 200, top: 200, bottom: 240, width: 120, height: 40 });
  const capture = world.resultsCapture();
  assert.equal(capture.iframeCount, 1);
  assert.equal(capture.iframes[0].src, "www.linkedin.com/preload/", "iframe src without its query");
  assert.equal(capture.shadowRootCount, 1);
  assert.equal(capture.doc.a, 2);
  assert.equal(capture.shadow.a, 1);
  assert.equal(capture.url, "https://www.linkedin.com/search/results/all/?keywords=Divya Saxena");
  assert.ok(capture.visibleLabels.length <= 40);
  const serialized = JSON.stringify(capture);
  assert.ok(!/secret|token|sid=/.test(serialized), "no input values, tokens, or extra query parameters");
  assert.equal(capture.peopleMentions.find((m) => m.where === "doc").qualifies, false, "People for another query does not qualify");
  assert.equal(capture.people.where, "shadow");
  assert.equal(capture.people.href, "/search/results/people/?keywords=Divya Saxena");
});

test("the header search input is found even though it sits above the content band", () => {
  const { document, world } = profileWorld('<header><nav><a href="/feed/">Home</a></nav><input placeholder="Search" type="text"></header><main><h1>Feed</h1></main>');
  document.querySelector("input").getBoundingClientRect = () => ({ x: 80, y: 8, top: 8, bottom: 42, width: 240, height: 34 });
  const box = world.searchBox();
  assert.equal(box?.kind, "input");
  assert.equal(box.y, 25);
  const results = profileWorld('<main><div><button>All</button><button>People</button><button>Posts</button></div><a href="/in/amy/">Amy Example</a></main><aside><button>People</button></aside>');
  const point = results.world.peopleFilter();
  assert.ok(point);
  results.document.elementFromPoint = () => results.document.querySelectorAll("button")[1];
  assert.equal(results.world.probePeopleFilter(point), true);
  results.document.elementFromPoint = () => results.document.querySelectorAll("button")[0];
  assert.equal(results.world.probePeopleFilter(point), false, "All is not People");
});

test("a Grow Connect hit-check failure does not click or reserve; two misses end invitations", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  document.elementFromPoint = () => document.querySelector("main");
  const { page, calls } = growPage(world);
  const state = productionState();
  const result = await runConnectionBatch(page, state, { maxAttempts: 3, pause: noPause, gapRange: [0, 0], shared: fakeShared(), rng: () => 0.99 });
  assert.equal(calls.clicks, 0);
  assert.equal(result.attempted, 0);
  assert.equal(state.actions.length, 0);
  assert.match(result.reason, /hit-check misses/);
  assert.equal(result.accountBlock, null);
});

test("Connect still offered after reload ends the batch and holds invites for the IST day, then the week", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  const amy = document.querySelector("#amy button");
  document.elementFromPoint = () => amy;
  const { page, calls } = growPage(world);
  const state = productionState();
  const shared = fakeShared();
  const result = await runConnectionBatch(page, state, { maxAttempts: 3, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared });
  assert.equal(calls.clicks, 1);
  assert.equal(calls.reloads, 1);
  assert.equal(result.attempted, 1, "no second invite after a still-offered card");
  assert.equal(result.accountBlock, null);
  assert.equal(state.pause, null, "no manual resume needed");
  assert.equal(state.inviteHold.kind, "still_offered_day");
  assert.equal(state.inviteHold.until, nextIstMidnight().toISOString());
  assert.equal(state.actions[0].status, "not_sent");
  assert.ok(inviteHoldReason(state));
  assert.equal(reserveAction(state, "connect", "https://www.linkedin.com/in/zed", { limit: 9, persist: () => {} }), null);
  assert.equal(shared.day.stillOffered.length, 1);

  // A second still-offered this UTC week asks for a hold until the weekly reset. The longer
  // hold wins: between IST midnight and the UTC Monday reset, the day hold already lasts longer.
  const dayUntil = new Date(state.inviteHold.until).getTime();
  const later = new Date(Date.now() + 60_000);
  recordStillOffered(state, { now: later });
  const weekUntil = nextWeeklyReset(later).getTime();
  assert.equal(state.inviteHold.kind, weekUntil > dayUntil ? "still_offered_week" : "still_offered_day");
  assert.equal(state.inviteHold.until, new Date(Math.max(weekUntil, dayUntil)).toISOString());
  assert.equal(state.inviteSignals.filter((signal) => signal.kind === "still_offered").length, 2);

  shared.day.stillOffered.push("p2", "p3");
  assert.match(inviteHoldReason(emptyState(), new Date(), shared), /3 profiles/);
});

test("an invitation-limit toast stops invites and holds them until the weekly reset without pausing", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  const amy = document.querySelector("#amy button");
  document.elementFromPoint = () => amy;
  const { page, calls } = growPage(world, {
    onClick: () => {
      const toast = document.createElement("div");
      toast.setAttribute("role", "alert");
      toast.textContent = "You've reached the weekly invitation limit";
      document.body.appendChild(toast);
    },
  });
  const state = productionState();
  const result = await runConnectionBatch(page, state, { maxAttempts: 3, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.equal(calls.clicks, 1);
  assert.equal(result.attempted, 1);
  assert.match(result.reason, /limit/);
  assert.equal(result.accountBlock, null);
  assert.equal(state.pause, null);
  assert.equal(state.inviteHold.kind, "invitation_limit");
  assert.equal(state.inviteHold.until, nextWeeklyReset().toISOString());
});

test("a known-not-sent invite does not become an uncertain_connection pause when a later step throws", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  const amy = document.querySelector("#amy button");
  document.elementFromPoint = () => amy;
  const { page } = growPage(world, {
    onClick: () => {
      const toast = document.createElement("div");
      toast.setAttribute("role", "alert");
      toast.textContent = "You've reached the weekly invitation limit";
      document.body.appendChild(toast);
    },
  });
  const state = productionState();
  const grow = await runConnectionBatch(page, state, { maxAttempts: 2, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.equal(grow.attempted, 1);
  assert.equal(state.actions[0].status, "not_sent");
  assert.equal(grow.sent[0].notSent, true);
  assert.equal(hasUncertainConnect(state, state.currentRun.id), false);
  // A later step throwing leaves the run for crash recovery, which is what the runner's catch mirrors.
  const steps = {
    feed: async () => ({ likes: 0, postsSeen: 9, aborted: false }),
    grow: async () => { throw new Error("Protocol error: Connection closed."); },
  };
  await assert.rejects(runPlannedSteps(page, state, { order: ["feed", "grow"], inviteCount: 2, sessionMs: 600_000 }, null, { steps }), /Connection closed/);
  recoverInterruptedRun(state, () => {});
  assert.equal(state.pause, null, "limit notice was a refusal, not an uncertain invite");
  assert.equal(state.inviteHold.kind, "invitation_limit");

  const pressed = productionState();
  weeklyBudget(pressed);
  reserveAction(pressed, "connect", "https://www.linkedin.com/in/zed", { limit: 1, persist: () => {} });
  assert.equal(hasUncertainConnect(pressed, pressed.currentRun.id), true, "a press with unknown outcome still pauses");
  recoverInterruptedRun(pressed, () => {});
  assert.equal(pressed.pause.kind, "uncertain_connection");
});

const GROW_TAB_PAGE = `<nav><a id="growtab" href="/mynetwork/grow/">Grow</a><a href="/mynetwork/catch-up/">Catch up</a></nav>${TWO_CARDS}`;

test("staying on /mynetwork does not end the batch before a Grow navigation attempt", async () => {
  const { document, world } = networkWorld(GROW_TAB_PAGE);
  const amy = document.querySelector("#amy button");
  document.elementFromPoint = () => amy;
  let url = "https://www.linkedin.com/mynetwork/";
  const asked = [];
  const clicks = [];
  const page = {
    url: () => url,
    goto: async () => { throw new Error("goto must not be used from My Network"); },
    reload: async () => {},
    evaluate: async (fn, ...args) => {
      if (!args.length) return { text: "", feedPresent: true };
      asked.push(args[1]);
      return world[args[1]](args[2]);
    },
    mouse: {
      move: async () => {},
      click: async () => {
        clicks.push(url);
        if (/\/mynetwork\/?$/.test(new URL(url).pathname)) url = "https://www.linkedin.com/mynetwork/grow/";
        else amy.textContent = "Pending";
      },
      wheel: async () => {},
    },
  };
  const state = productionState();
  const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.ok(asked.includes("growTab"), "looked for the Grow tab");
  assert.equal(clicks[0], "https://www.linkedin.com/mynetwork/", "first press was the Grow tab on bare /mynetwork");
  assert.ok(asked.indexOf("growTab") < asked.indexOf("inspect"), "no suggestion pass before Grow was opened");
  assert.equal(url, "https://www.linkedin.com/mynetwork/grow/");
  assert.equal(result.attempted, 1);
  assert.equal(result.connections, 1);
  assert.equal(result.accountBlock, null);

  // If the Grow tab never appears, the batch ends after navigation attempts, not on a stuck-layout count.
  const bare = networkWorld(TWO_CARDS);
  bare.document.elementFromPoint = () => bare.document.querySelector("#amy button");
  let growLooks = 0;
  let pressed = 0;
  const stuck = {
    url: () => "https://www.linkedin.com/mynetwork/",
    goto: async () => { throw new Error("no goto"); },
    evaluate: async (fn, ...args) => {
      if (!args.length) return { text: "", feedPresent: true };
      if (args[1] === "growTab") growLooks += 1;
      return bare.world[args[1]](args[2]);
    },
    mouse: { move: async () => {}, click: async () => { pressed += 1; }, wheel: async () => {} },
  };
  const ended = await runConnectionBatch(stuck, productionState(), { maxAttempts: 2, pause: noPause, gapRange: [0, 0], shared: fakeShared() });
  assert.ok(growLooks >= 3, `Grow tab looked for ${growLooks} times`);
  assert.equal(pressed, 0, "no Connect press off /mynetwork/grow/");
  assert.match(ended.reason, /did not reach \/mynetwork\/grow\//);
  assert.doesNotMatch(ended.reason, /scroller/);
  assert.equal(ended.accountBlock, null);
});

test("the Grow tab is found when aria-label and text both say Grow, or it is a role=tab", () => {
  const both = networkWorld('<div><button role="tab" aria-label="Grow">Grow</button><button role="tab" aria-label="Catch up">Catch up</button></div><main></main>');
  assert.ok(both.world.growTab());
  const tab = networkWorld('<div><div role="tab">Grow</div></div><main></main>');
  assert.ok(tab.world.growTab());
  const none = networkWorld('<div><a href="/mynetwork/catch-up/">Catch up</a><button>Growth tips</button></div><main></main>');
  assert.equal(none.world.growTab(), null);
  assert.ok(none.world.networkTabs().some((t) => /Catch up/.test(t.label)));
});

test("Grow never presses a page-wide Show more; it wheels the suggestions area", async () => {
  const { world } = networkWorld('<main><button aria-label="Ignore an invitation to connect from Ada">Ignore</button><button>Show more</button><button>Show all</button></main>');
  const { page, calls } = growPage(world);
  const state = productionState();
  const result = await runConnectionBatch(page, state, { maxAttempts: 2, maxDurationMs: 30_000, pause: noPause, gapRange: [0, 0], shared: fakeShared() });
  assert.equal(calls.clicks, 0);
  assert.ok(calls.wheels >= 2, `wheels ${calls.wheels}`);
  assert.equal(result.attempted, 0);
  assert.equal(result.accountBlock, null);
});

test("Grow does not open a profile even when views were requested", async () => {
  const { document, world } = networkWorld(`<nav><a href="/mynetwork/">My Network</a></nav>${TWO_CARDS}`);
  const link = document.querySelector("#amy a");
  document.elementFromPoint = () => link;
  let url = "https://www.linkedin.com/mynetwork/grow/";
  const pressed = [];
  let lastAsked = null;
  const page = {
    url: () => url,
    goBack: async () => { throw new Error("Browser Back is never used"); },
    goto: async () => { throw new Error("no goto"); },
    evaluate: async (fn, ...args) => {
      if (!args.length) return { text: "", feedPresent: true };
      lastAsked = args[1];
      return world[args[1]](args[2]);
    },
    mouse: {
      move: async () => {},
      click: async () => {
        if (/\/in\//.test(url)) {
          if (lastAsked !== "myNetwork") throw new Error("nothing on a profile is clicked but the My Network nav");
          pressed.push("NAV");
          url = "https://www.linkedin.com/mynetwork/grow/";
          return;
        }
        pressed.push(document.elementFromPoint().tagName);
        url = "https://www.linkedin.com/in/amy";
      },
      wheel: async () => {},
    },
  };
  const state = productionState();
  let beats = 0;
  const reads = [];
  const result = await runConnectionBatch(page, state, {
    maxAttempts: 0, growVisits: 1, pause: noPause, rng: () => 0, shared: fakeShared(),
    onHeartbeat: () => { beats += 1; },
    readProfile: async (p, opts) => { reads.push(p.url()); opts.onHeartbeat(); },
  });
  assert.deepEqual(pressed, []);
  assert.deepEqual(reads, []);
  assert.equal(result.visits, 0);
  assert.equal(result.attempted, 0);
  assert.equal(result.accountBlock, null);
  assert.equal(url, "https://www.linkedin.com/mynetwork/grow/");
  assert.equal(beats, 0);
});

test("inspectAccount ignores 'unusual activity' and 'enter the code' in posts, headlines, and results", async () => {
  const snapshot = (html) => {
    const { document } = parseHTML(html);
    return vm.runInNewContext(`(${accountSnapshotWorld.toString()})()`, { document });
  };
  const pageFor = (html, url) => ({ url: () => url, evaluate: async () => snapshot(html) });
  const nav = '<header><nav><a href="/feed/">Home</a><a href="/mynetwork/">My Network</a></nav></header>';
  const feed = `${nav}<main><div data-testid="mainFeed"><div componentkey="update-card-1"><p>We saw unusual activity on our servers. Enter the code HIRE20 at checkout.</p><div role="alert">unusual activity</div></div></div></main>`;
  assert.equal(await inspectAccount(pageFor(feed, "https://www.linkedin.com/feed/")), null);
  const profile = `${nav}<main><section><h1>Amy</h1><p>Fraud analyst | I catch unusual activity | enter the code of conduct</p></section></main>`;
  assert.equal(await inspectAccount(pageFor(profile, "https://www.linkedin.com/in/amy/")), null);
  const results = `${nav}<main><ul><li>Security lead: unusual activity detection. Enter the code review.</li></ul></main>`;
  assert.equal(await inspectAccount(pageFor(results, "https://www.linkedin.com/search/results/people/?keywords=x")), null);
  const limit = `${nav}<main></main><div class="artdeco-toast-item">You've reached the weekly invitation limit</div>`;
  assert.equal(await inspectAccount(pageFor(limit, "https://www.linkedin.com/mynetwork/grow/")), null, "an invitation limit is an invite hold, not a pause");
  const dialog = `${nav}<main></main><div role="dialog">We noticed unusual activity. Please enter the code we sent.</div>`;
  assert.equal((await inspectAccount(pageFor(dialog, "https://www.linkedin.com/feed/"))).kind, "challenge");
  assert.equal((await inspectAccount(pageFor(`${nav}<main></main>`, "https://www.linkedin.com/checkpoint/challenge/x"))).kind, "challenge");
  assert.equal((await inspectAccount(pageFor("<html><body><main>Sign in to LinkedIn</main></body></html>", "https://www.linkedin.com/feed/"))).kind, "login");
  assert.equal(classifyAccount("https://www.linkedin.com/in/amy/", "", true, "unusual activity"), null);
});

test("post text quoting the invitation limit is not treated as a limit notice", () => {
  const { world } = networkWorld('<main><div data-testid="mainFeed"><div componentkey="update-card-1"><p>Tip: after the weekly invitation limit, wait a week.</p><span aria-live="polite">weekly invitation limit</span></div></div></main>');
  assert.equal(world.limitNotice({ pattern: "invitation limit" }).found, false);
  const toast = networkWorld('<main></main><div class="artdeco-toast-item">You have reached the weekly invitation limit</div>');
  assert.equal(toast.world.limitNotice({ pattern: "invitation limit" }).found, true);
  const recorded = emptyState();
  recordInviteLimit(recorded);
  assert.equal(recorded.inviteHold.until, nextWeeklyReset().toISOString());
});

function profileWorld(html, { href = "https://www.linkedin.com/in/amy/" } = {}) {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll("*")) {
    el.getBoundingClientRect = () => ({ x: 300, y: 200, top: 200, bottom: 240, width: 120, height: 40 });
  }
  return { document, world: vm.runInNewContext(`(${profileDomWorld.toString()})()`, { document, location: { origin: "https://www.linkedin.com", href }, innerHeight: 900, getComputedStyle: () => ({ visibility: "visible" }), URL }) };
}

const NO_H1 = (body) => `<!doctype html><html><head><title>(3) Rahul Kale | LinkedIn</title></head><body><main><div class="card"><p>Rahul Kale</p>${body}</div>
  <section><h2>People also viewed</h2><a href="/preload/custom-invite/?vanityName=someone">Invite Someone Else to connect</a><button>Connect</button></section></main></body></html>`;

test("profile Connect without a main h1 takes the name from the title and accepts only the named invite", () => {
  const anchor = profileWorld(NO_H1('<a href="/preload/custom-invite/?vanityName=rahul-kale" aria-label="Invite Rahul Kale to connect">Connect</a><button>Message</button>'));
  assert.equal(anchor.world.profileName(), "Rahul Kale");
  const point = anchor.world.connectPoint();
  assert.equal(point.found, true, JSON.stringify(point));
  assert.equal(point.label, "Invite Rahul Kale to connect");
  assert.equal(anchor.world.connectWhere().found, true);
  anchor.document.elementFromPoint = () => anchor.document.querySelector("a[aria-label='Invite Rahul Kale to connect']");
  assert.equal(anchor.world.probeConnect(point), true);
  anchor.document.elementFromPoint = () => anchor.document.querySelector("section a");
  assert.equal(anchor.world.probeConnect(point), false, "someone else's invite is refused");

  const bare = profileWorld(NO_H1("<button>Connect</button>"));
  assert.equal(bare.world.connectPoint().found, false, "a bare Connect without a top card is ambiguous");
  const sticky = profileWorld(NO_H1('<a href="/preload/custom-invite/?v=r" aria-label="Invite Rahul Kale to connect">Connect</a><div class="sticky"><button aria-label="Invite Rahul Kale to connect">Connect</button></div>'));
  assert.equal(sticky.world.connectPoint().found, true, "top card plus sticky header copy is one control");
  const pending = profileWorld(NO_H1('<button aria-label="Pending, click to withdraw invitation sent to Rahul Kale">Pending</button>'));
  assert.equal(pending.world.pendingOnProfile(), true);
  const otherPending = profileWorld(NO_H1('<button aria-label="Pending, click to withdraw invitation sent to Someone Else">Pending</button>'));
  assert.equal(otherPending.world.pendingOnProfile(), false);
});

test("the People filter matches a labelled pill or a People link for the same keywords, never another query", () => {
  const href = "https://www.linkedin.com/search/results/all/?keywords=Priya%20Malhotra&origin=GLOBAL_SEARCH_HEADER";
  const link = profileWorld('<main><nav aria-label="Search filters"><a href="/search/results/people/?keywords=Priya%20Malhotra&origin=SWITCH_SEARCH_VERTICAL">Show all people results</a></nav></main>', { href });
  assert.ok(link.world.peopleFilter(), "a People results link for the same keywords");
  link.document.elementFromPoint = () => link.document.querySelector("a");
  assert.equal(link.world.probePeopleFilter({ x: 1, y: 1 }), true);
  const counted = profileWorld('<main><button aria-label="People 1,203">People</button></main>', { href });
  assert.ok(counted.world.peopleFilter());
  const other = profileWorld('<main><a href="/search/results/people/?keywords=Someone%20Else">See people</a><button>Posts</button></main>', { href });
  assert.equal(other.world.peopleFilter(), null, "a People link for another query is refused");
  assert.ok(other.world.filterDiagnostics().some((entry) => entry.includes("Posts")));
});

const TOP_CARD = (buttons) => `<main><section><h1>Amy Example</h1><p>Founder</p>${buttons}</section>
  <aside><button aria-label="Invite Rohit Kumar to connect">Connect</button><button>Connect</button></aside></main>`;

test("profile Connect only matches an exact top-card Connect; Message, Follow, More, menus, and the side rail are ignored", () => {
  const none = profileWorld(TOP_CARD('<button>Message</button><button aria-label="Follow Amy Example">Follow</button><button aria-label="More actions">More</button><div role="menu"><button>Connect</button></div>'));
  assert.equal(none.world.connectPoint().found, false);
  const other = profileWorld(TOP_CARD('<button aria-label="Invite Someone Else to connect">Connect</button>'));
  assert.equal(other.world.connectPoint().found, false);
  const partial = profileWorld(TOP_CARD("<button>Connect now</button>"));
  assert.equal(partial.world.connectPoint().found, false);
  const exact = profileWorld(TOP_CARD('<button>Message</button><button>Connect</button><button aria-label="More actions">More</button>'));
  assert.equal(exact.world.connectPoint().found, true);
  const invite = profileWorld(TOP_CARD('<button aria-label="Invite Amy Example to connect">Connect</button>'));
  const point = invite.world.connectPoint();
  assert.equal(point.found, true);
  invite.document.elementFromPoint = () => invite.document.querySelector("aside button");
  assert.equal(invite.world.probeConnect(point), false, "a hit on the side rail is refused");
  invite.document.elementFromPoint = () => invite.document.querySelector("section button");
  assert.equal(invite.world.probeConnect(point), true);
});

test("a profile or company visit only scrolls and dwells: no Follow, Message, More, Connect, or any click", async () => {
  for (const [url, kind] of [["https://www.linkedin.com/in/amy/", "person"], ["https://www.linkedin.com/company/acme/", "company"]]) {
    let wheels = 0;
    let beats = 0;
    const page = {
      url: () => url,
      mouse: {
        move: async () => {},
        wheel: async () => { wheels += 1; },
        click: async () => { throw new Error("profile reading must not click"); },
        down: async () => { throw new Error("no press"); },
      },
      keyboard: { press: async () => { throw new Error("no keys"); } },
      evaluate: async () => { throw new Error("no DOM clicks"); },
    };
    const read = await readProfilePage(page, { pause: noPause, onHeartbeat: () => { beats += 1; } });
    assert.equal(read.read, true);
    assert.equal(read.kind, kind);
    assert.ok(wheels >= 3);
    assert.ok(beats > wheels, "heartbeat through the dwell");
  }
});

test("a profile Connect hit-check failure does not click or reserve", async () => {
  const { document, world } = profileWorld(TOP_CARD("<button>Connect</button>"));
  document.elementFromPoint = () => document.querySelector("h1");
  let clicks = 0;
  const page = {
    url: () => "https://www.linkedin.com/in/amy/",
    evaluate: async (fn, ...args) => (args.length ? world[args[1]](args[2]) : { text: "", feedPresent: true }),
    mouse: { move: async () => {}, click: async () => { clicks += 1; } },
  };
  const state = productionState();
  const out = await profileConnect(page, state, { url: "https://www.linkedin.com/in/amy/", pause: noPause, shared: fakeShared() });
  assert.equal(clicks, 0);
  assert.equal(out.attempted, 0);
  assert.equal(state.actions.length, 0);
  assert.equal(out.reason, "hit-check-failed");
});

function feedWorld(html, rects) {
  const { document, window } = parseHTML(html);
  const fallback = box(0, 0, 0, 0);
  for (const el of document.querySelectorAll("*")) {
    const key = el.getAttribute("componentkey") || el.getAttribute("data-rect") || "";
    el.getBoundingClientRect = () => ({ ...(rects[key] || fallback) });
  }
  document.elementFromPoint = (x, y) => {
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll("button, a")) {
      const r = el.getBoundingClientRect();
      if (x < r.x || y < r.y || x > r.x + r.width || y > r.y + r.height) continue;
      if (r.width * r.height < bestArea) { best = el; bestArea = r.width * r.height; }
    }
    return best;
  };
  const sandbox = { document, window: { innerHeight: 900, ...(window || {}) }, innerHeight: 900, location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" }, getComputedStyle: () => ({ visibility: "visible" }), URL };
  const helpers = vm.runInNewContext(`(${feedDomHelpers.toString()})()`, sandbox);
  return vm.runInNewContext(`(${feedDomWorld.toString()})(helpers)`, { ...sandbox, helpers });
}

const VISIT_FEED = `<main><div data-testid="mainFeed" data-rect="feed">
  <div role="listitem" data-rect="rec"><h2>Recommended for you</h2>
    <div data-rect="row1"><a data-rect="n1" href="/in/ghazal/">Ghazal Alagh</a><button data-rect="f1" aria-label="Follow Ghazal Alagh">Follow</button></div>
    <div data-rect="row2"><a data-rect="n2" href="/company/findmyicp/">FindMyICP</a><button data-rect="f2" aria-label="Follow FindMyICP">Follow</button></div>
    <button data-rect="showmore">Show more</button>
  </div>
  <div componentkey="update-card-person"><a data-rect="author1" href="/in/christian-meram/">Christian Meram</a>
    <button data-rect="follow1" aria-label="Follow Christian Meram">Follow</button><p>A long enough post body for the feed.</p>
    <div><button data-rect="like1" aria-label="Reaction button state: no reaction Like">Like</button><button data-rect="c1">Comment</button></div></div>
  <div componentkey="update-card-company"><a data-rect="author2" href="/company/acme/">Acme Corp</a><p>Company update body text.</p>
    <div><button data-rect="like2" aria-label="Reaction button state: no reaction Like">Like</button><button data-rect="c2">Comment</button></div></div>
  <div componentkey="update-card-ad"><span>Promoted</span><a data-rect="author3" href="/in/ad-person/">Ad Person</a>
    <div><button data-rect="like3" aria-label="Reaction button state: no reaction Like">Like</button><button data-rect="c3">Comment</button></div></div>
</div></main>`;

const VISIT_RECTS = {
  feed: box(288, 0, 400, 3000),
  rec: box(288, 150, 400, 200), row1: box(288, 200, 400, 40), n1: box(300, 205, 120, 20), f1: box(600, 205, 60, 28),
  row2: box(288, 250, 400, 40), n2: box(300, 255, 120, 20), f2: box(600, 255, 60, 28), showmore: box(420, 310, 100, 24),
  "update-card-person": box(288, 360, 400, 200), author1: box(300, 370, 140, 20), follow1: box(600, 370, 60, 28), like1: box(300, 520, 80, 30), c1: box(400, 520, 80, 30),
  "update-card-company": box(288, 580, 400, 150), author2: box(300, 590, 120, 20), like2: box(300, 690, 80, 30), c2: box(400, 690, 80, 30),
  "update-card-ad": box(1000, 360, 400, 150), author3: box(1010, 380, 100, 20), like3: box(1010, 470, 80, 30), c3: box(1100, 470, 80, 30),
};

test("an expanded card and its focus card are the same post", () => {
  const card = (key) => `<main><div data-testid="mainFeed" data-rect="feed"><div componentkey="${key}"><p>Same post body long enough to count.</p><button data-rect="like" aria-label="Like">Like</button></div></div></main>`;
  const rects = { feed: box(288, 0, 400, 2000), [""]: box(0, 0, 0, 0) };
  const expandedKey = "expandedABC123FeedType_MAIN_FEED_RELEVANCE";
  const focusKey = "update-card-focusABC123FeedType_MAIN_FEED_RELEVANCE";
  rects[expandedKey] = box(288, 180, 400, 220);
  rects[focusKey] = box(288, 180, 400, 220);
  const expanded = feedWorld(card(expandedKey), rects).collect()[0];
  const focus = feedWorld(card(focusKey), rects).collect()[0];
  assert.equal(expanded.urn, focus.urn);
  assert.equal(expanded.urn, "ABC123FeedType_MAIN_FEED_RELEVANCE");
});

test("a feed video exposes a mute control and the probe accepts only that button", () => {
  const html = `<main><div data-testid="mainFeed" data-rect="feed">
    <div componentkey="update-card-video">
      <a data-rect="author" href="/in/kunal/">Kunal</a>
      <p>A video post with enough text to be a real update on the home feed today.</p>
      <video data-rect="vid"></video>
      <button data-rect="mute" aria-label="Unmute">Unmute</button>
      <button data-rect="like" aria-label="Reaction button state: no reaction Like">Like</button>
    </div>
  </div></main>`;
  const world = feedWorld(html, {
    feed: box(288, 0, 400, 2000),
    "update-card-video": box(288, 180, 400, 420),
    author: box(300, 190, 80, 20),
    vid: box(300, 230, 360, 200),
    mute: box(310, 400, 36, 36),
    like: box(300, 540, 80, 30),
  });
  const [post] = world.collect();
  assert.equal(post.hasVideo, true);
  assert.equal(post.hasMute, true);
  const point = world.locate(post.urn, "mute");
  assert.ok(point);
  assert.equal(world.probe(point.x, point.y, "mute", post.urn).safe, true);
  const like = world.locate(post.urn, "like");
  assert.equal(world.probe(like.x, like.y, "mute", post.urn).safe, false);
});

test("feed views target post authors and person module rows; ads, company rows, Follow, and Show more are excluded", () => {
  const world = feedWorld(VISIT_FEED, VISIT_RECTS);
  const targets = world.visitTargets();
  const byUrl = Object.fromEntries(targets.map((t) => [t.url, t]));
  assert.deepEqual(Object.keys(byUrl).sort(), [
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/in/christian-meram/",
    "https://www.linkedin.com/in/ghazal/",
  ]);
  assert.equal(byUrl["https://www.linkedin.com/in/ghazal/"].source, "module");
  assert.equal(byUrl["https://www.linkedin.com/company/acme/"].kind, "company");
  const author = byUrl["https://www.linkedin.com/in/christian-meram/"];
  assert.equal(world.probe(author.x, author.y, "visit", author.url).safe, true);
  for (const key of ["follow1", "f1", "showmore", "like1"]) {
    const r = VISIT_RECTS[key];
    assert.equal(world.probe(r.x + 5, r.y + 5, "visit", "https://www.linkedin.com/in/ghazal/").safe, false, key);
  }
  const ad = VISIT_RECTS.author3;
  assert.equal(world.probe(ad.x + 5, ad.y + 5, "visit", "https://www.linkedin.com/in/ad-person/").safe, false);
  // The Follow path still refuses a name link, so the two paths stay separate.
  assert.equal(world.probe(author.x, author.y, "follow", author.url).safe, false);
});

test("the feed refuses profile views even when a plan asks for them", async () => {
  let clicks = 0;
  const human = {
    revealControl: async () => { clicks += 1; return { x: 1, y: 1 }; },
    clickAt: async () => { clicks += 1; return true; },
  };
  const optimizer = { state: productionState(), plan: { feedVisits: 3, verify: true, searchConnect: true, warmupMs: 0, windDownMs: 0 } };
  const stats = { feedVisits: 0 };
  const visit = await maybeVisitFromFeed({ url: () => "https://www.linkedin.com/feed/" }, human, optimizer, stats, {
    started: 0, endsAt: Date.now() + 10 * 60_000, rng: () => 0, visitChance: 1,
  });
  assert.equal(visit.visited, false);
  assert.equal(visit.reason, "profile-views-disabled");
  assert.equal(clicks, 0);
  assert.equal(stats.feedVisits, 0);
});

test("old state files without the new fields still load, and invalid new fields fail closed", () => {
  const path = scopedStatePath();
  const old = emptyState();
  for (const key of ["searchQueries", "visitedUrls", "inviteHold", "inviteSignals"]) delete old[key];
  old.daily["2026-09-14"] = { likes: 1, sessions: 1, postsSeen: 10, aborted: 0 };
  writeFileSync(path, JSON.stringify(old));
  const loaded = loadState();
  assert.deepEqual(loaded.searchQueries, []);
  assert.deepEqual(loaded.visitedUrls, []);
  assert.equal(loaded.inviteHold, null);
  assert.deepEqual(loaded.inviteSignals, []);
  rememberVisit(loaded, "https://www.linkedin.com/in/Amy/?miniProfile=1", () => {});
  assert.ok(alreadyVisited(loaded, "https://www.linkedin.com/in/amy/"));
  writeFileSync(path, JSON.stringify({ ...old, inviteHold: { until: "not a date" } }));
  assert.throws(() => loadState(), /invite hold/);
  writeFileSync(path, JSON.stringify({ ...old, searchQueries: "aman" }));
  assert.throws(() => loadState(), /searchQueries/);
});

test("preflight drops invites while a hold is active and still does not open profiles", () => {
  const state = emptyState();
  state.inviteHold = { kind: "still_offered_day", reason: "x", at: new Date().toISOString(), until: new Date(Date.now() + 3600_000).toISOString() };
  for (let i = 0; i < 50; i += 1) {
    const plan = new Optimizer(state).preflight().plan;
    assert.equal(plan.inviteCount, 0);
    assert.equal(plan.searchConnect, false);
    if (!plan.growVisits) assert.ok(!plan.order.includes("grow"));
  }
});

test("removed overrides are gone and connect-only cannot clear pauses", () => {
  const sources = ["src/activity.js", "src/runner.js", "src/config.js", "scripts/connect-only.mjs"].map((file) => readFileSync(join(repo, file), "utf8")).join("\n");
  for (const name of ["CONNECT_IGNORE_DAILY_CAP", "CONNECT_MAX_ATTEMPTS", "CONNECT_REVIEWED"]) assert.ok(!sources.includes(name), name);
  const connectOnly = readFileSync(join(repo, "scripts/connect-only.mjs"), "utf8");
  assert.ok(!/state\.pause\s*=\s*null/.test(connectOnly));
  assert.ok(config.followsEnabled !== undefined, "FOLLOWS_ENABLED is still honored");
});

// A page whose DOM follows its URL: the feed, a bare /mynetwork that paints an empty main (as
// the Aditi retests saw), and /mynetwork/grow/ with cards.
function routedNetworkPage({ bareUntil = Infinity, gotoFails = true } = {}) {
  const NAV = '<nav><a href="/feed/">Home</a><a href="/mynetwork/">My Network</a></nav>';
  const worlds = {
    feed: networkWorld(`${NAV}<main><p>feed</p></main>`),
    bare: networkWorld(`${NAV}<main></main>`),
    grow: networkWorld(`${NAV}${TWO_CARDS}`),
  };
  const amy = worlds.grow.document.querySelector("#amy button");
  worlds.grow.document.elementFromPoint = () => amy;
  let url = "https://www.linkedin.com/feed/";
  let lastAsked = null;
  let networkLoads = 0;
  const events = [];
  const route = () => (/\/mynetwork\/grow\//.test(url) ? worlds.grow : /\/mynetwork/.test(url) ? worlds.bare : worlds.feed);
  const landNetwork = () => { networkLoads += 1; url = networkLoads > bareUntil ? "https://www.linkedin.com/mynetwork/grow/" : "https://www.linkedin.com/mynetwork"; };
  const page = {
    url: () => url,
    goBack: async () => { throw new Error("Browser Back is never used"); },
    goto: async (to) => {
      events.push("goto");
      if (gotoFails) { url = "chrome-error://chromewebdata/"; throw new Error("net::ERR_TUNNEL_CONNECTION_FAILED at " + to); }
      url = to;
    },
    reload: async () => { events.push("reload"); if (/\/mynetwork/.test(url)) landNetwork(); },
    evaluate: async (fn, ...args) => {
      if (!args.length) return { overlays: [], chromePresent: true, bodyText: "" };
      lastAsked = args[1];
      return route().world[args[1]](args[2]);
    },
    mouse: {
      move: async () => {},
      click: async () => {
        if (lastAsked === "myNetwork") { events.push(`nav@${new URL(url).pathname}`); landNetwork(); return; }
        if (lastAsked === "growTab") { events.push("growTab"); url = "https://www.linkedin.com/mynetwork/grow/"; return; }
        events.push("connect");
        amy.textContent = "Pending";
      },
      wheel: async () => {},
    },
  };
  return { page, events, url: () => url };
}

test("Grow tries a second My Network press and a reload before any goto when /mynetwork paints empty", async () => {
  const ok = routedNetworkPage({ bareUntil: 2 });
  const state = productionState();
  const result = await runConnectionBatch(ok.page, state, { maxAttempts: 1, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.deepEqual(ok.events.slice(0, 3), ["nav@/feed/", "nav@/mynetwork", "reload"], ok.events.join(","));
  assert.ok(!ok.events.includes("goto"), "reload reached Grow, so goto was never used");
  assert.equal(ok.url(), "https://www.linkedin.com/mynetwork/grow/");
  assert.equal(result.attempted, 1);
  assert.equal(result.connections, 1);
  assert.equal(result.accountBlock, null);

  const failed = routedNetworkPage();
  const failedState = productionState();
  const ended = await runConnectionBatch(failed.page, failedState, { maxAttempts: 2, pause: noPause, gapRange: [0, 0], shared: fakeShared() });
  const gotoAt = failed.events.indexOf("goto");
  assert.ok(gotoAt > failed.events.indexOf("reload") && failed.events.indexOf("reload") > failed.events.indexOf("nav@/mynetwork"), failed.events.join(","));
  assert.equal(failed.events.filter((e) => e === "goto").length, 1, "goto is tried once, last");
  assert.ok(!failed.events.includes("connect"), "no card pressed off /mynetwork/grow/");
  assert.match(ended.reason, /Grow navigation failed/);
  assert.equal(ended.accountBlock, null, "a failed goto onto chrome-error is not an account block");
  assert.equal(failedState.pause, null);
});

test("search clear rejects a concatenated value and never appends a second query", async () => {
  const selected = searchPage({ startValue: "Naveen BansalMohit Sen", backspaceWorks: false, selectWorks: true, enterTab: "people" });
  const cleared = await runSearch(selected.page, productionState(), { search: true }, { pause: noPause, shared: fakeShared(), read: async () => {} });
  assert.equal(selected.calls.submitted.length, 1);
  assert.equal(selected.calls.submitted[0], cleared.query, "select-node clear left exactly the new query");

  const refill = searchPage({ refillWith: "Naveen Bansal", enterTab: "people" });
  const state = productionState();
  const refused = await runSearch(refill.page, state, { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { throw new Error("no profile"); } });
  assert.equal(refill.calls.typed.length, 1, "stopped at the first character once old text reappeared");
  assert.equal(refill.calls.submitted.length, 0, "a concatenated box is never submitted");
  assert.equal(refused.accountBlock, null);
  assert.equal(state.pause, null);
  assert.match(refused.reason, /not usable/);
});

test("the search typeahead blocks result clicks: one See all results press, then results", async () => {
  const { page, calls } = searchPage({ enterTab: null, typeaheadAfterEnter: 99, seeAllWorks: true });
  const reads = [];
  const out = await runSearch(page, productionState(), { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { reads.push(page.url()); } });
  const seeAll = calls.clicks.filter((c) => c.x === 320 && c.y === 136);
  assert.equal(seeAll.length, 1);
  const results = calls.clicks.filter((c) => c.x === 400);
  assert.equal(results.length, 1, "one person opened");
  assert.ok(results.every((c) => !c.typeaheadOpen), "no result click while the typeahead is open");
  assert.equal(out.visits, 1);
  assert.equal(calls.gotos, 0);
  assert.equal(page.url(), "https://www.linkedin.com/feed/", "returned through Home");
});

test("a chrome-error return does not use Back, abort the session, or pause the profile", async () => {
  assert.equal(classifyAccount("chrome-error://chromewebdata/"), null);
  const { page, calls } = searchPage({ enterTab: "people" });
  const state = productionState();
  const out = await runSearch(page, state, { search: true }, { pause: noPause, shared: fakeShared(), read: async () => { page.setUrl("chrome-error://chromewebdata/"); } });
  assert.equal(calls.backs, 0, "no history.back from an error page");
  assert.equal(calls.reloads, 1);
  assert.equal(out.returned, true);
  assert.equal(out.accountBlock, null);
  assert.equal(state.pause, null);

  const steps = {
    feed: async () => ({ likes: 0, postsSeen: 9, aborted: false }),
    search: async () => ({ searched: true, visits: 1, returned: false, accountBlock: null, reason: null }),
    grow: async () => ({ connections: 0, attempted: 0, reason: "Grow navigation failed: My Network did not reach /mynetwork/grow/", accountBlock: null }),
  };
  const planState = productionState();
  const result = await runPlannedSteps({}, planState, { order: ["search", "feed", "grow"], search: true, inviteCount: 1, sessionMs: 600_000 }, null, { steps });
  assert.equal(result.aborted, false, "a failed return and a failed Grow navigation leave the session running");
  assert.equal(result.accountBlock, undefined);
  assert.equal(result.searchOpened, false);
  assert.equal(result.searchReturned, null);
  assert.equal(planState.pause, null);
});

test("verification does not open a company or person page from the feed", async () => {
  let clicks = 0;
  const visit = await maybeVisitFromFeed({ url: () => "https://www.linkedin.com/feed/" }, {
    revealControl: async () => { clicks += 1; return { x: 1, y: 1 }; },
    clickAt: async () => { clicks += 1; return true; },
  }, { state: productionState(), plan: { verify: true, feedVisits: 3, warmupMs: 0, windDownMs: 0 } }, { feedVisits: 0 }, {
    started: 0, endsAt: Date.now() + 10 * 60_000, rng: () => 0, visitChance: 1,
  });
  assert.equal(visit.visited, false);
  assert.equal(clicks, 0);
});

test("profile Connect ignores a search-results row Connect and a list Connect outside the top card", async () => {
  const { document, world } = profileWorld('<main><h1>Search results</h1><ul><li><a href="/in/amy/">Amy Example</a><button aria-label="Invite Amy Example to connect">Connect</button></li></ul></main>');
  document.elementFromPoint = () => document.querySelector("button");
  let clicks = 0;
  const page = {
    url: () => "https://www.linkedin.com/search/results/people/?keywords=Amy%20Example",
    evaluate: async (fn, ...args) => (args.length ? world[args[1]](args[2]) : { overlays: [], chromePresent: true, bodyText: "" }),
    mouse: { move: async () => {}, click: async () => { clicks += 1; } },
  };
  const state = productionState();
  const out = await profileConnect(page, state, { url: "https://www.linkedin.com/in/amy/", pause: noPause, shared: fakeShared() });
  assert.equal(clicks, 0);
  assert.equal(out.attempted, 0);
  assert.equal(out.reason, "not-on-profile");
  assert.equal(state.actions.length, 0);

  const listed = profileWorld('<main><section><h1>Amy Example</h1><button>Message</button></section><section><h2>People also viewed</h2><button>Connect</button></section></main>');
  assert.equal(listed.world.connectPoint().found, false, "a Connect in another main section is not the top card");
});

test("the header search box accepts a placeholder hit in its combobox and follows focus into the typeahead input", () => {
  const { document, world } = profileWorld('<header><div role="combobox"><span id="ph">Search</span><input id="box" placeholder="Search" type="text"><button id="icon" aria-label="Search">o</button></div></header><div id="overlay"><input id="typed" role="combobox" aria-label="Search" type="text"></div><main><h1>Feed</h1></main>');
  for (const el of document.querySelectorAll("header *, #overlay *")) el.getBoundingClientRect = () => ({ x: 80, y: 8, top: 8, bottom: 42, width: 240, height: 34 });
  const box = world.searchBox();
  assert.equal(box?.kind, "input");
  document.elementFromPoint = () => document.querySelector("#ph");
  assert.equal(world.probeSearchBox(box), true, "placeholder span over the box");
  document.elementFromPoint = () => document.querySelector("#icon");
  assert.equal(world.probeSearchBox(box), false, "a button inside the box is refused");
  Object.defineProperty(document, "activeElement", { value: document.querySelector("#typed"), configurable: true });
  assert.equal(world.searchFocused(), true);
  document.querySelector("#typed").value = "Aman";
  assert.equal(world.searchValue(), "Aman", "value is read from the focused input");
});

test("profile Connect wheels back to a top-card Connect the read scrolled away, then presses it once", async () => {
  const { document, world } = profileWorld(TOP_CARD("<button>Message</button><button>Connect</button>"));
  const connect = [...document.querySelectorAll("section button")].find((b) => b.textContent === "Connect");
  let offset = 900;
  connect.getBoundingClientRect = () => ({ x: 300, y: 200 - offset, top: 200 - offset, bottom: 240 - offset, width: 120, height: 40 });
  document.elementFromPoint = () => connect;
  const wheels = [];
  let clicks = 0;
  const page = {
    url: () => "https://www.linkedin.com/in/amy/",
    reload: async () => {},
    evaluate: async (fn, ...args) => (args.length ? world[args[1]]?.(args[2]) : { overlays: [], chromePresent: true, bodyText: "" }),
    mouse: {
      move: async () => {},
      wheel: async ({ deltaY }) => { wheels.push(deltaY); offset += deltaY; },
      click: async () => { clicks += 1; connect.setAttribute("aria-label", "Pending"); },
    },
  };
  const state = productionState();
  const out = await profileConnect(page, state, { url: "https://www.linkedin.com/in/amy/", pause: noPause, shared: fakeShared() });
  assert.ok(wheels.length >= 1 && wheels[0] < 0, `wheeled up ${wheels}`);
  assert.equal(clicks, 1);
  assert.equal(out.attempted, 1);
  assert.equal(out.connections, 1);
  assert.equal(out.accountBlock, null);
});

test("a profile with no exact Connect keeps the run's one attempt; a later profile with that person's Invite link spends it with one click", async () => {
  const state = productionState();
  const clicks = [];
  const profilePage = (url, world, onClick = () => {}) => ({
    url: () => url,
    reload: async () => {},
    evaluate: async (fn, ...args) => (args.length ? world[args[1]]?.(args[2]) : { overlays: [], chromePresent: true, bodyText: "" }),
    mouse: { move: async () => {}, wheel: async () => {}, click: async () => { clicks.push(url); onClick(); } },
  });

  const first = profileWorld(TOP_CARD('<button aria-label="Follow Amy Example">Follow</button><button>Message</button><button aria-label="More actions">More</button>'
    + '<a href="/preload/search-custom-invite/?v=amy" aria-label="Invite Amy Example to connect">Connect</a>'));
  first.document.elementFromPoint = () => first.document.querySelector("section button");
  const skipped = await profileConnect(profilePage("https://www.linkedin.com/in/amy/", first.world), state, { url: "https://www.linkedin.com/in/amy/", pause: noPause, shared: fakeShared() });
  assert.equal(skipped.reason, "no-connect");
  assert.equal(skipped.attempted, 0);
  assert.equal(clicks.length, 0, "Follow, Message, More, a search-row invite, and People also viewed are never clicked");
  assert.equal(verifyNeeds(state).connect, true, "the attempt is not consumed");

  const later = profileWorld(NO_H1('<a href="/preload/custom-invite/?vanityName=rahul-kale" aria-label="Invite Rahul Kale to connect">Connect</a><button>Message</button><button aria-label="More actions">More</button>'), { href: "https://www.linkedin.com/in/rahul-kale/" });
  const invite = later.document.querySelector("a[aria-label='Invite Rahul Kale to connect']");
  later.document.elementFromPoint = () => invite;
  const sent = await profileConnect(profilePage("https://www.linkedin.com/in/rahul-kale/", later.world, () => invite.setAttribute("aria-label", "Pending, click to withdraw invitation sent to Rahul Kale")), state, { url: "https://www.linkedin.com/in/rahul-kale/", pause: noPause, shared: fakeShared() });
  assert.deepEqual(clicks, ["https://www.linkedin.com/in/rahul-kale/"], "exactly one click, on the named Invite link");
  assert.equal(sent.attempted, 1);
  assert.equal(sent.connections, 1);
  assert.equal(sent.sent[0].name, "Rahul Kale");
  assert.equal(verifyNeeds(state).connect, false, "the attempt is now spent");
});

test("a company view can come from an open person profile and clicks only the company link", async () => {
  const { document, world } = profileWorld('<main><section><h1>Amy Example</h1></section><section><h2>Experience</h2><a id="co" href="/company/acme/">Acme Corp</a><button>Follow</button></section></main>');
  const link = document.querySelector("#co");
  document.elementFromPoint = () => link;
  let url = "https://www.linkedin.com/in/amy/";
  const clicked = [];
  const page = {
    url: () => url,
    evaluate: async (fn, ...args) => (args.length ? world[args[1]](args[2]) : { overlays: [], chromePresent: true, bodyText: "" }),
    mouse: {
      move: async () => {},
      wheel: async () => {},
      click: async () => {
        if (/\/company\//.test(url)) throw new Error("nothing on the company page is clicked");
        clicked.push(document.elementFromPoint().getAttribute("href"));
        url = "https://www.linkedin.com/company/acme/";
      },
    },
  };
  const state = productionState();
  const reads = [];
  const out = await visitCompanyFromProfile(page, state, { pause: noPause, read: async (p) => { reads.push(p.url()); } });
  assert.equal(out.visited, true);
  assert.deepEqual(clicked, ["/company/acme/"]);
  assert.deepEqual(reads, ["https://www.linkedin.com/company/acme/"]);
  assert.equal(verifyNeeds(state).company, false);
  assert.ok(alreadyVisited(state, "https://www.linkedin.com/company/acme/"));
});

test("production and verification plans never open profiles or connect off My Network", () => {
  const random = Array.from({ length: 200 }, () => new Optimizer(emptyState()).preflight().plan);
  assert.ok(random.every((p) => !p.search && !p.searchConnect && p.feedVisits === 0 && p.growVisits === 0 && !p.verify));
  assert.ok(random.some((p) => p.inviteCount === 0));
  assert.ok(random.some((p) => p.order.includes("grow")));
  assert.ok(random.every((p) => p.order[0] === "feed" && !p.order.includes("search")));
  config.verifyWarmup = true;
  try {
    const plan = new Optimizer(emptyState()).preflight().plan;
    assert.equal(plan.verify, true);
    assert.equal(plan.search, false);
    assert.equal(plan.searchConnect, false);
    assert.equal(plan.feedVisits, 0);
    assert.equal(plan.growVisits, 0);
    assert.ok(!plan.order.includes("search"));
    assert.ok(plan.followCap >= 1 && plan.followCap <= 2);
  } finally { config.verifyWarmup = false; }
});

test("connection requests are never planned from search", () => {
  for (let i = 0; i < 200; i += 1) {
    const flow = sampleFlow();
    assert.equal(flow.searchConnect, false);
    assert.equal(flow.search, false);
  }
  config.verifyWarmup = true;
  try { assert.equal(new Optimizer(productionState()).preflight().plan.searchConnect, false); }
  finally { config.verifyWarmup = false; }
});

test("schedule and scheduled workers ignore VERIFY_WARMUP; one-shot once honors it", async () => {
  const { resolveVerifyWarmup } = await import("../src/config.js");
  const { workerEnv, workerArgs } = await import("../src/service.js");
  assert.deepEqual(resolveVerifyWarmup(["schedule"], { VERIFY_WARMUP: "1" }), { verifyWarmup: false, ignored: true });
  assert.deepEqual(resolveVerifyWarmup(["schedule", "--verify-warmup"], {}), { verifyWarmup: false, ignored: true });
  assert.deepEqual(resolveVerifyWarmup(["once", "--profile", "p", "--window", "2026-09-27:overnight"], { VERIFY_WARMUP: "true" }), { verifyWarmup: false, ignored: true });
  assert.deepEqual(resolveVerifyWarmup(["once", "--verify-warmup"], { WARMUP_SCHEDULED_WORKER: "1" }), { verifyWarmup: false, ignored: true });
  assert.deepEqual(resolveVerifyWarmup(["once"], { VERIFY_WARMUP: "1" }), { verifyWarmup: true, ignored: false });
  assert.deepEqual(resolveVerifyWarmup(["once", "--verify-warmup"], {}), { verifyWarmup: true, ignored: false });
  assert.deepEqual(resolveVerifyWarmup(["once"], {}), { verifyWarmup: false, ignored: false });
  const env = workerEnv({ VERIFY_WARMUP: "1", PATH: "/bin", TEST_RUN: "true" });
  assert.equal("VERIFY_WARMUP" in env, false);
  assert.equal(env.WARMUP_SCHEDULED_WORKER, "1");
  assert.equal(env.TEST_RUN, "false");
  assert.equal(env.PATH, "/bin");
  const args = workerArgs("/x/index.js", "p1", "2026-09-27:overnight");
  assert.ok(args.includes("--window") && !args.includes("--verify-warmup"));
  assert.deepEqual(resolveVerifyWarmup(args.slice(1), env), { verifyWarmup: false, ignored: false });
  assert.deepEqual(resolveVerifyWarmup(args.slice(1), { ...env, VERIFY_WARMUP: "1" }), { verifyWarmup: false, ignored: true });
});

function stallingPressCdp(sent) {
  return async () => ({
    send: (_method, params) => {
      sent.push(params.type);
      return params.type === "mousePressed" ? new Promise(() => {}) : Promise.resolve();
    },
    detach: async () => {},
  });
}

test("a timed-out Grow Connect press goes out once after one curved move, is never re-sent, and does not pause", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  document.elementFromPoint = () => document.querySelector("#amy button");
  const sent = [];
  const { page, calls } = growPage(world);
  page.createCDPSession = stallingPressCdp(sent);
  page.bringToFront = async () => {};
  const state = productionState();
  const out = await runConnectionBatch(page, state, { maxAttempts: 2, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.equal(sent.filter((t) => t === "mousePressed").length, 1, "one press, never a second");
  assert.equal(sent.filter((t) => t === "mouseReleased").length, 1);
  assert.ok(sent.indexOf("mousePressed") >= 10, "a multi-step curved move precedes the press");
  assert.equal(calls.clicks, 0, "page.mouse.click is not used when CDP is available");
  assert.equal(calls.reloads, 0);
  assert.equal(out.connections, 0);
  assert.equal(out.accountBlock ?? null, null);
  assert.match(out.reason, /not delivered/);
  assert.equal(out.sent[0].notSent, true);
  assert.equal(state.actions.at(-1).status, "not_sent");
  assert.equal(state.pause, null);
  assert.equal(state.inviteHold ?? null, null, "a stalled press is not a still-offered hold");
});

test("a timed-out profile Connect press is not re-sent and does not pause the profile", async () => {
  const { document, world } = profileWorld(TOP_CARD("<button>Message</button><button>Connect</button>"));
  const connect = [...document.querySelectorAll("section button")].find((b) => b.textContent === "Connect");
  document.elementFromPoint = () => connect;
  const sent = [];
  const page = {
    url: () => "https://www.linkedin.com/in/amy/",
    reload: async () => { throw new Error("no reload after a stalled press"); },
    bringToFront: async () => {},
    evaluate: async (fn, ...args) => (args.length ? world[args[1]]?.(args[2]) : { overlays: [], chromePresent: true, bodyText: "" }),
    mouse: { move: async () => {}, wheel: async () => {}, click: async () => { throw new Error("page.mouse.click must not be used"); } },
    createCDPSession: stallingPressCdp(sent),
  };
  const state = productionState();
  const out = await profileConnect(page, state, { url: "https://www.linkedin.com/in/amy/", pause: noPause, shared: fakeShared() });
  assert.equal(sent.filter((t) => t === "mousePressed").length, 1);
  assert.ok(sent.indexOf("mousePressed") >= 10, "curved move first");
  assert.equal(out.attempted, 1);
  assert.equal(out.connections, 0);
  assert.equal(out.accountBlock, null);
  assert.match(out.reason, /not delivered/);
  assert.equal(state.actions.at(-1).status, "not_sent");
  assert.equal(state.pause, null);
});

test("tests never write the repo log file", () => {
  assert.ok(!logFile.startsWith(join(repo, "logs")), logFile);
  assert.ok(sampleSessionPlan().order.includes("feed"));
  assert.equal(utcWeekKey(new Date("2026-09-27T12:00:00Z")), "2026-09-21");
});

test("SESSION_MINUTES overrides production session length and is validated", () => {
  const saved = process.env.SESSION_MINUTES;
  try {
    process.env.SESSION_MINUTES = "5,10";
    for (let i = 0; i < 200; i += 1) {
      const { sessionMs } = sampleSessionPlan();
      assert.ok(sessionMs >= 5 * 60_000 && sessionMs <= 10 * 60_000, String(sessionMs));
    }
    for (const bad of ["10,5", "0,5", "5,21", "5", "a,b"]) {
      process.env.SESSION_MINUTES = bad;
      assert.throws(() => sampleSessionPlan(), /SESSION_MINUTES must be two integers/);
    }
    delete process.env.SESSION_MINUTES;
    assert.ok(sampleSessionPlan().sessionMs >= config.sessionMinutes.min * 60_000);
  } finally {
    if (saved === undefined) delete process.env.SESSION_MINUTES;
    else process.env.SESSION_MINUTES = saved;
  }
});


test("Gaurav: the recheck after a Grow reload waits for the cards before deciding", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  const amy = document.querySelector("#amy button");
  document.elementFromPoint = () => amy;
  let reloaded = false;
  let readyCalls = 0;
  const slowGrow = {
    ...world,
    growReady: () => {
      if (reloaded && (readyCalls += 1) === 3) {
        document.querySelector("main").innerHTML = '<li id="ben"><a href="https://www.linkedin.com/in/ben">Ben Example</a><button>Connect</button></li>';
        for (const el of document.querySelectorAll("*")) el.getBoundingClientRect = () => ({ x: 300, y: 150, top: 150, bottom: 190, width: 120, height: 40 });
      }
      return world.growReady();
    },
  };
  const { page, calls } = growPage(slowGrow, {
    onReload: () => { reloaded = true; document.querySelector("main").innerHTML = ""; },
  });
  const state = productionState();
  const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.equal(calls.reloads, 1);
  assert.ok(readyCalls >= 3, "the cards were awaited after the reload");
  assert.equal(result.accountBlock, null, "a re-rendered Grow without the invitee is not an uncertain invite");
  assert.equal(result.sent[0].confirmed, true);
});

test("a Grow page that never re-renders after the recheck keeps the uncertain-invite pause", async () => {
  const { document, world } = networkWorld(TWO_CARDS);
  const amy = document.querySelector("#amy button");
  document.elementFromPoint = () => amy;
  const { page } = growPage(world, { onReload: () => { document.querySelector("main").innerHTML = ""; } });
  const state = productionState();
  const result = await runConnectionBatch(page, state, { maxAttempts: 1, pause: noPause, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared() });
  assert.equal(result.accountBlock?.kind, "uncertain_connection");
  assert.equal(hasUncertainConnect(state, state.currentRun.id), true);
});

test("a Pending card with mutual-connection links is still matched to the invitee", () => {
  const { world } = networkWorld(`<main>
    <li id="amy"><div><a href="https://www.linkedin.com/in/amy">Amy Example</a><span><a href="https://www.linkedin.com/in/mutual-one">M1</a> and <a href="https://www.linkedin.com/in/mutual-two">M2</a> are mutual connections</span></div><button aria-label="Pending, click to withdraw invitation sent to Amy Example">Pending</button></li>
    <li id="ben"><a href="https://www.linkedin.com/in/ben">Ben Example</a><button>Connect</button></li>
  </main>`);
  assert.equal(world.pending({ url: "https://www.linkedin.com/in/amy" }), true);
  assert.equal(world.pending({ url: "https://www.linkedin.com/in/ben" }), false);
  assert.equal(world.pending({ url: "https://www.linkedin.com/in/mutual-one" }), false, "a mutual connection is not the invitee");
});

test("leaving My Network pauses only when an invite outcome is unknown or the page is off LinkedIn", async () => {
  const at = (href, extra = {}) => ({ url: () => href, ...extra });
  const clean = productionState();
  const onFeed = await leftMyNetwork(at("https://www.linkedin.com/feed/"), clean);
  assert.equal(onFeed.action, "end");
  assert.match(onFeed.reason, /\/feed\//);
  assert.equal((await leftMyNetwork(at("https://evil.example/"), clean)).action, "pause");
  const swapped = at("https://www.linkedin.com/mynetwork/grow/");
  assert.equal((await leftMyNetwork(swapped, clean)).action, "continue");

  const uncertain = productionState();
  weeklyBudget(uncertain);
  reserveAction(uncertain, "connect", "https://www.linkedin.com/in/zed", { limit: 1, persist: () => {} });
  assert.equal((await leftMyNetwork(at("https://www.linkedin.com/feed/"), uncertain)).action, "pause");
});


function manyCards(count) {
  const names = Array.from({ length: count }, (_, i) => `Person${i} Example`);
  const html = `<main>${names.map((name, i) => `<li id="p${i}"><a href="https://www.linkedin.com/in/person${i}">${name}</a><button>Connect</button></li>`).join("")}</main>`;
  const built = networkWorld(html);
  const nextConnect = () => [...built.document.querySelectorAll("main button")].find((b) => b.textContent === "Connect");
  built.document.elementFromPoint = () => nextConnect() || null;
  const onClick = () => {
    const button = nextConnect();
    const name = button.parentElement.querySelector("a").textContent;
    button.textContent = "Pending";
    button.setAttribute("aria-label", `Pending, click to withdraw invitation sent to ${name}`);
  };
  return { ...built, onClick };
}

test("Grow under a short time budget sends fewer invites and never shortens the human gap", async () => {
  const { world, onClick } = manyCards(9);
  const start = Date.now();
  let now = start;
  const pressedAt = [];
  const { page } = growPage(world, { onClick: () => { pressedAt.push(now); onClick(); } });
  const state = productionState();
  const result = await runConnectionBatch(page, state, {
    maxAttempts: 7, maxDurationMs: 150_000, gapRange: [25_000, 60_000], pickCandidate: firstCard, shared: fakeShared(),
    pause: async (ms) => { now += Number(ms) || 0; }, clock: () => now,
  });
  assert.ok(result.attempted >= 1 && result.attempted < 7, `attempted ${result.attempted}`);
  assert.match(result.reason || "", /time budget/);
  assert.equal(result.accountBlock, null);
  for (let i = 1; i < pressedAt.length; i += 1) assert.ok(pressedAt[i] - pressedAt[i - 1] >= 25_000, "gaps stay at least 25s");
  assert.ok(now - start <= 150_000, `Grow used ${Math.round((now - start) / 1000)}s of a 150s budget`);
});

test("Grow waits for the cards to paint and settles 1.5-4s before the first scroll", async () => {
  const events = [];
  let readyCalls = 0;
  const ready = [{ rendered: false }, { rendered: true, people: 8, cardControls: 6 }, { rendered: true, people: 11, cardControls: 9 }, { rendered: true, people: 11, cardControls: 9 }];
  const page = { evaluate: async (_fn, _src, method) => (method === "growReady" ? ready[Math.min(readyCalls++, ready.length - 1)] : null) };
  await settleGrow(page, { pause: async (ms) => { events.push(ms); } });
  assert.equal(readyCalls, 4, "polled until two identical painted samples");
  const settle = events.at(-1);
  assert.ok(settle >= GROW_SETTLE_MS[0] && settle <= GROW_SETTLE_MS[1], `settle ${settle}`);

  const { document, world } = networkWorld(TWO_CARDS);
  document.elementFromPoint = () => document.querySelector("#amy button");
  const order = [];
  const { page: grow } = growPage(world);
  const wheel = grow.mouse.wheel;
  grow.mouse.wheel = async (...args) => { order.push("wheel"); return wheel(...args); };
  await runConnectionBatch(grow, productionState(), {
    maxAttempts: 1, gapRange: [0, 0], pickCandidate: firstCard, shared: fakeShared(),
    pause: async (ms) => { if (ms >= GROW_SETTLE_MS[0] && ms <= GROW_SETTLE_MS[1]) order.push("settle"); },
  });
  assert.ok(order.indexOf("settle") >= 0 && order.indexOf("settle") < order.indexOf("wheel"), order.join(","));
});

const { growCardsPainted } = await import("../src/scenario/linkedinNetwork.js");

test("Banwari: one person link and no card controls is not a painted Grow page", async () => {
  assert.equal(growCardsPainted({ rendered: true, people: 1, cardControls: 0 }), false);
  assert.equal(growCardsPainted({ rendered: true, people: 13, cardControls: 10 }), true);
  let polls = 0;
  const pauses = [];
  const page = { evaluate: async (_fn, _src, method) => (method === "growReady" ? (polls += 1, { rendered: true, people: 1, cardControls: 0 }) : null) };
  const ready = await settleGrow(page, { pause: async (ms) => { pauses.push(ms); }, polls: 6 });
  assert.equal(polls, 6, "two identical empty samples do not count as settled");
  assert.equal(ready.people, 1);
  const settle = pauses.at(-1);
  assert.ok(settle >= GROW_SETTLE_MS[0] && settle <= GROW_SETTLE_MS[1], "still settles before proceeding carefully");
});

test("Mohit: Grow input that never acknowledges is bounded and the batch ends with a reason, not silence", async () => {
  const { document, world } = networkWorld("<main><p>No suggestions</p></main>");
  document.elementFromPoint = () => null;
  const { page } = growPage(world);
  page.mouse.move = () => new Promise(() => {});
  page.mouse.wheel = () => new Promise(() => {});
  const startedAt = Date.now();
  const result = await runConnectionBatch(page, productionState(), {
    maxAttempts: 1, maxDurationMs: 90_000, gapRange: [0, 0], shared: fakeShared(), pause: noPause, inputTimeoutMs: 20,
  });
  assert.ok(Date.now() - startedAt < 10_000, "hung pointer input did not wait out the protocol timeout");
  assert.equal(result.attempted, 0);
  assert.ok(result.reason, "the reason is recorded");

  const later = networkWorld(TWO_CARDS);
  later.document.elementFromPoint = () => later.document.querySelector("#amy button");
  let now = Date.now();
  const { page: slow } = growPage(later.world);
  const out = await runConnectionBatch(slow, productionState(), {
    maxAttempts: 1, maxDurationMs: 20_000, gapRange: [0, 0], pickCandidate: () => ({ candidate: null, skipped: [] }), shared: fakeShared(),
    pause: async (ms) => { now += Number(ms) || 0; }, clock: () => now,
  });
  assert.match(out.reason || "", /time budget|No unambiguous|suggestion/);
});
