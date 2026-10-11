import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";

const root = mkdtempSync(join(tmpdir(), "feed-reload-"));
process.env.WARMUP_DATA_DIR = root;
process.env.WARMUP_LOG_DIR = join(root, "logs");
process.env.GL_PROFILE_NAME = "Fixture";
process.env.GL_PROFILE_ID = "fixture";

const { actOnShortColumn, columnNeedsRevival, detachedInspectAction, emptyCollectorAction, hardRefreshFeed, loadRealFeed, recoverHomeFeed, refreshEmptyFeed, requireHomeFeed, shortFeedAbortReason, shouldAbortFewPosts, scrollHoldReason, noteStillLoadingScroll, feedLooksPainted, PAINTED_HOLD_LIMIT, FEED_LOADING_PASS_LIMIT } = await import("../src/scenario/linkedinFeed.js");
const { HumanController } = await import("../src/human/input.js");
const { thinFollowGate } = await import("../src/scenario/linkedinFeed.js");
// Press-targeting tests approve every control; follow policy is tested with the real gate.
const pressAll = { approve: () => ({ allow: true, actionId: "fixture" }), finish: () => {} };
const { feedDomWorld, feedDomHelpers } = await import("../src/scenario/linkedinDom.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("a detached frame continues only when a live page remains", () => {
  const detached = new Error("Attempted to use detached Frame '59B61CE3F1BCCBA4A7561B989896BB62'.");
  assert.deepEqual(detachedInspectAction(detached, { url: () => "https://www.linkedin.com/feed/" }), { action: "continue" });
  assert.deepEqual(detachedInspectAction(detached, null), { action: "infra" });
  assert.equal(detachedInspectAction(new Error("inspect timed out"), null), null);
});

test("a See new posts miss does not reload posts that were already collected", () => {
  assert.equal(emptyCollectorAction({ visibleUpdates: 4, postsSeen: 3 }), "keep");
  assert.equal(emptyCollectorAction({ visibleUpdates: 0, postsSeen: 3, seeNewMisses: 1 }), "scroll");
  assert.equal(emptyCollectorAction({ visibleUpdates: 0, postsSeen: 0, seeNewMisses: 1 }), "reload");
  assert.equal(emptyCollectorAction({ nullRoot: true, postsSeen: 3, seeNewMisses: 1 }), "reload-root");
});

function bindWorld(document) {
  const sandbox = {
    document,
    window: { innerHeight: 900, innerWidth: 1280 },
    location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
    getComputedStyle: () => ({ visibility: "visible" }),
    URL,
  };
  const helpers = vm.runInNewContext(`(${feedDomHelpers.toString()})()`, sandbox);
  return vm.runInNewContext(`(${feedDomWorld.toString()})(helpers)`, { ...sandbox, helpers, document, window: sandbox.window });
}

function feedWorld(html, rects = {}) {
  const { document } = parseHTML(html);
  const fallback = { x: 300, y: 200, top: 200, bottom: 560, width: 540, height: 360, left: 300, right: 840 };
  for (const el of document.querySelectorAll("*")) {
    const key = el.getAttribute("componentkey") || el.id || el.getAttribute("data-rect") || "";
    const rect = rects[key] || fallback;
    el.getBoundingClientRect = () => ({ ...rect });
  }
  document.elementFromPoint = () => null;
  return { document, world: bindWorld(document) };
}

function feedPage(href) {
  const events = [];
  const page = {
    href,
    url() { return page.href; },
    reload: async (options) => { events.push({ action: "reload", ...(options || {}) }); },
    goto: async (url) => {
      events.push(`goto:${url}`);
      page.href = url;
    },
  };
  return { page, events };
}

test("a short non-empty column clicks new posts and then loads the real feed URL", async () => {
  const { page, events } = feedPage("https://www.linkedin.com/feed/");
  const clicks = [];
  const human = {
    postsCacheAt: 0,
    clickAt: async (x, y, kind) => {
      clicks.push({ x, y, kind });
      return true;
    },
  };
  const stats = { postsSeen: 3, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 };
  const observed = {
    postsSeen: 3,
    maxTop: 642,
    firstTop: 196,
    visibleUpdates: 4,
    url: "https://www.linkedin.com/feed/",
    pill: { x: 480, y: 220, label: "New posts" },
  };
  const first = await actOnShortColumn(page, human, stats, observed, {
    pause: async () => {},
    waitMs: 0,
    countUnique: async () => 3,
  });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].kind, "see-new");
  assert.equal(clicks[0].x, 480);
  assert.equal(events.some((event) => String(event).startsWith("goto:")), false);
  assert.equal(events.filter((event) => event.action === "reload").length, 0);
  assert.equal(first.loaded, false);
  assert.equal(first.postsSeen, 3);
  assert.equal(first.gaveUp, true);

  const second = await actOnShortColumn(page, human, stats, observed, {
    pause: async () => {},
    waitMs: 0,
    countUnique: async () => 3,
  });
  assert.equal(events.filter((event) => event.action === "reload").length, 0);
  assert.equal(events.some((event) => String(event).startsWith("goto:")), false);
  assert.equal(second.gaveUp, true);
  assert.equal(second.scroll, false);
});

test("new-posts click that increases unique posts does not also load the feed", async () => {
  const { page, events } = feedPage("https://www.linkedin.com/feed/");
  const clicks = [];
  const stats = { postsSeen: 4, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 };
  const result = await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async (_x, _y, kind) => {
      clicks.push(kind);
      return true;
    },
  }, stats, {
    postsSeen: 4,
    maxTop: 301,
    firstTop: 196,
    visibleUpdates: 3,
    url: page.url(),
    pill: { x: 500, y: 180, label: "नई पोस्ट" },
  }, {
    pause: async () => {},
    waitMs: 0,
    countUnique: async () => 8,
  });
  assert.deepEqual(clicks, ["see-new"]);
  assert.equal(events.length, 0);
  assert.equal(result.postsSeen, 8);
  assert.equal(result.loaded, false);
  assert.equal(result.gaveUp, false);
});

test("a tall column with few unique posts is not treated as a short feed", async () => {
  const { page, events } = feedPage("https://www.linkedin.com/feed/");
  const clicks = [];
  const result = await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async () => {
      clicks.push("see-new");
      return true;
    },
  }, { postsSeen: 3, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
    postsSeen: 3,
    maxTop: 3165,
    firstTop: 216,
    visibleUpdates: 6,
    url: page.url(),
    pill: { x: 480, y: 200, label: "New posts" },
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 3 });
  assert.equal(clicks.length, 0);
  assert.equal(events.length, 0);
  assert.equal(result.acted, false);
});

test("chrome-error is never reloaded; three failed feed loads throw instead of returning false", async () => {
  const { page, events } = feedPage("chrome-error://chromewebdata/");
  const waits = [];
  page.goto = async (url, options) => {
    events.push({ action: "goto", url, options });
    page.href = "chrome-error://chromewebdata/";
  };
  await assert.rejects(
    () => actOnShortColumn(page, {
      postsCacheAt: 0,
      clickAt: async () => { events.push("click"); return true; },
    }, { postsSeen: 8, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
      postsSeen: 8,
      maxTop: 1692,
      firstTop: 180,
      visibleUpdates: 8,
      url: "chrome-error://chromewebdata/",
      pill: { x: 10, y: 10, label: "New posts" },
    }, {
      pause: async (min, max) => { waits.push([min, max]); },
      waitMs: 0,
      countUnique: async () => 8,
    }),
    (error) => error.failureKind === "infra" && /chrome-error/i.test(error.message),
  );
  assert.equal(events.some((event) => event?.action === "reload"), false);
  assert.equal(events.includes("click"), false);
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.url, "https://www.linkedin.com/feed/");
    assert.deepEqual(event.options, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  assert.deepEqual(waits, [[8_000, 10_000], [8_000, 10_000]]);
  assert.equal(page.href, "chrome-error://chromewebdata/");

  const homeEvents = [];
  const dead = feedPage("chrome-error://chromewebdata/");
  dead.page.goto = async (url, options) => {
    homeEvents.push({ url, options });
    dead.page.href = "chrome-error://chromewebdata/";
  };
  await assert.rejects(
    () => recoverHomeFeed(dead.page, { postsSeen: 8 }, { pause: async () => {} }),
    (error) => error.failureKind === "infra",
  );
  assert.equal(homeEvents.length, 3);
  assert.equal(dead.events.includes("reload"), false);
});

test("a login or checkpoint during chrome-error recovery stops so the account check can pause", async () => {
  const wall = (hrefAfter) => {
    const events = [];
    const page = {
      href: "chrome-error://chromewebdata/",
      url() { return page.href; },
      reload: async () => { events.push("reload"); },
      screenshot: async () => {},
      evaluate: async () => ({ overlays: [], chromePresent: false, bodyText: "" }),
      goto: async (url) => {
        events.push(url);
        page.href = hrefAfter;
      },
    };
    return { page, events };
  };

  const login = wall("https://www.linkedin.com/uas/login");
  const recovered = await recoverHomeFeed(login.page, { postsSeen: 8 }, { pause: async () => {} });
  assert.equal(recovered, false);
  assert.deepEqual(login.events, ["https://www.linkedin.com/feed/"]);

  const challenge = wall("https://www.linkedin.com/checkpoint/challenge/");
  const result = { aborted: false, checkpoint: false, accountBlock: null };
  const held = await requireHomeFeed(challenge.page, { postsSeen: 8 }, result);
  assert.equal(held, "blocked");
  assert.equal(result.aborted, true);
  assert.equal(result.checkpoint, true);
  assert.equal(result.accountBlock.kind, "challenge");
  assert.deepEqual(challenge.events, ["https://www.linkedin.com/feed/"]);
  assert.equal(challenge.events.includes("reload"), false);
});

test("a collapsed scroller loads the real feed URL and does not reload chrome-error", async () => {
  const collapsed = feedPage("https://www.linkedin.com/feed/");
  const again = await actOnShortColumn(collapsed.page, {
    postsCacheAt: 0,
    clickAt: async () => { collapsed.events.push("click"); return true; },
  }, { postsSeen: 3, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
    postsSeen: 3,
    maxTop: 28,
    firstTop: 529,
    visibleUpdates: 1,
    url: "https://www.linkedin.com/feed/",
    pill: null,
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 3 });
  assert.equal(collapsed.events.some((event) => String(event).startsWith("goto:")), false);
  assert.equal(collapsed.events.length, 1);
  assert.equal(collapsed.events[0].action, "reload");
  assert.equal(collapsed.events[0].ignoreCache, true);
  assert.equal(again.scroll, false);
});

test("visible update nodes are not an empty column and are not reloaded", async () => {
  const { page, events } = feedPage("https://www.linkedin.com/feed/");
  const result = await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async () => { events.push("click"); return true; },
  }, { postsSeen: 8, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
    postsSeen: 8,
    maxTop: 2400,
    firstTop: 180,
    visibleUpdates: 7,
    collectorEmpty: true,
    url: page.url(),
    pill: { x: 1, y: 1, label: "New posts" },
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 8 });
  assert.equal(result.reason, "updates-present");
  assert.equal(result.acted, false);
  assert.equal(events.length, 0);

  const empty = feedPage("https://www.linkedin.com/feed/");
  assert.equal(await refreshEmptyFeed(empty.page, {}, { pause: async () => {}, visibleUpdates: 7 }), false);
  assert.equal(empty.events.length, 0);
  assert.equal(empty.events.includes("reload"), false);
});

test("postCards does not throw when the feed root falls through to a null body", () => {
  const { document } = parseHTML("<!doctype html><html><head></head><body><p>mid navigation</p></body></html>");
  const bare = {
    querySelector: (selector) => (selector === "body" ? null : document.querySelector(selector)),
    querySelectorAll: (selector) => document.querySelectorAll(selector),
    body: null,
    documentElement: document.documentElement,
    title: "",
    readyState: "loading",
    elementFromPoint: () => null,
  };
  assert.equal(bare.body, null);
  assert.equal(bare.querySelector("main"), null);
  const world = bindWorld(bare);
  assert.doesNotThrow(() => world.collect());
  assert.equal(world.collect().length, 0);
  assert.doesNotThrow(() => world.inspect());
  assert.equal(world.inspect().socialPosts, 0);
  assert.doesNotThrow(() => world.dump());
  assert.equal(world.pointerBounds(), null);
});

test("a suggestions module is not counted as the only feed posts", () => {
  const { world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" id="suggest" componentkey="expandedm0cFeedType_MAIN_FEED_RELEVANCE">
          फ़ीड की पोस्ट आपके लिए सुझाव Meesho
          <button>Meesho को फ़ॉलो करें</button>
          <button>ITC Limited को फ़ॉलो करें</button>
        </div>
      </div>
    </main>
  </body></html>`, {
    suggest: { x: 300, y: 180, top: 180, bottom: 640, width: 540, height: 460, left: 300, right: 840 },
    expandedm0cFeedType_MAIN_FEED_RELEVANCE: { x: 300, y: 180, top: 180, bottom: 640, width: 540, height: 460, left: 300, right: 840 },
  });
  assert.equal(world.collect().length, 0);
  assert.equal(world.inspect().socialPosts, 0);

  const mixed = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="suggestFeedType_MAIN_FEED_RELEVANCE">
          Suggestions for you
          <button>Follow Meesho</button>
        </div>
        <div role="listitem" componentkey="expandedrealFeedType_MAIN_FEED_RELEVANCE" id="expandedrealFeedType_MAIN_FEED_RELEVANCE">
          A real update with a social bar.
          <button aria-label="Open control menu for post by Asha"></button>
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>
        </div>
      </div>
    </main>
  </body></html>`, {
    suggestFeedType_MAIN_FEED_RELEVANCE: { x: 300, y: 160, top: 160, bottom: 420, width: 540, height: 260, left: 300, right: 840 },
    expandedrealFeedType_MAIN_FEED_RELEVANCE: { x: 300, y: 440, top: 440, bottom: 860, width: 540, height: 420, left: 300, right: 840 },
  });
  const posts = mixed.world.collect();
  assert.equal(posts.length, 1);
  assert.match(posts[0].urn, /expandedrealFeedType_MAIN_FEED_RELEVANCE|realFeedType_MAIN_FEED_RELEVANCE/);
});

test("a scrollable short column is not stranded just because a post sits low in the viewport", () => {
  const feed = "https://www.linkedin.com/feed/";
  assert.equal(columnNeedsRevival({ postsSeen: 3, maxTop: 622, firstTop: 864, url: feed }), "short");
  assert.equal(columnNeedsRevival({ postsSeen: 3, maxTop: 28, firstTop: 529, url: feed }), "collapsed");
  assert.equal(columnNeedsRevival({ postsSeen: 3, maxTop: 120, firstTop: 529, url: feed }), "stranded");
});

test("an off-screen new posts control is scrolled into view before the click point is returned", () => {
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <button data-rect="pill">New posts</button>
      </div>
    </main>
  </body></html>`, {
    pill: { x: 480, y: -40, top: -40, bottom: -4, left: 400, right: 560, width: 160, height: 36 },
  });
  const button = document.querySelector("button");
  let revealed = false;
  const off = { x: 480, y: -40, top: -40, bottom: -4, left: 400, right: 560, width: 160, height: 36 };
  const on = { x: 480, y: 220, top: 220, bottom: 256, left: 400, right: 560, width: 160, height: 36 };
  button.scrollIntoView = () => { revealed = true; };
  button.getBoundingClientRect = () => (revealed ? on : off);
  const found = world.findSeeNewPosts();
  assert.equal(revealed, true);
  assert.equal(found.label, "New posts");
  assert.ok(found.y > 200);
});

test("a listed new posts button is pressed, and the abort does not claim a click that did not happen", async () => {
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <button data-rect="pill"><span data-rect="glyph">New posts</span></button>
      </div>
    </main>
  </body></html>`, {
    pill: { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    glyph: { x: 480, y: -40, top: -40, bottom: -4, left: 400, right: 560, width: 160, height: 36 },
  });
  const span = document.querySelector("span");
  const button = document.querySelector("button");
  let revealed = false;
  const off = { x: 480, y: -40, top: -40, bottom: -4, left: 400, right: 560, width: 160, height: 36 };
  const on = { x: 480, y: 220, top: 220, bottom: 256, left: 400, right: 560, width: 160, height: 36 };
  button.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  span.scrollIntoView = () => { revealed = true; };
  span.getBoundingClientRect = () => (revealed ? on : off);
  const labels = world.inspect().buttonLabels;
  assert.ok(labels.includes("new posts"), `inspect did not list the control: ${labels.join(" | ")}`);
  const found = world.findSeeNewPosts();
  assert.equal(revealed, true);
  assert.ok(found && found.y > 200, "listed new posts button produced no click point");

  const reloads = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async (options) => { reloads.push(options); },
    goto: async () => { throw new Error("goto is not a hard refresh"); },
    evaluate: async (fn, ...args) => vm.runInNewContext(
      `(${fn.toString()})(...args)`,
      {
        document,
        window: { innerHeight: 900, innerWidth: 1280 },
        location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
        getComputedStyle: () => ({ visibility: "visible" }),
        URL,
        args,
      },
    ),
  };
  const stats = { postsSeen: 3, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0, seeNewPostsAtRecovery: 0 };
  await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async () => { throw new Error("zero-box new posts must not be pressed before the hard refresh"); },
  }, stats, {
    postsSeen: 3,
    maxTop: 622,
    firstTop: 864,
    visibleUpdates: 7,
    url: page.url(),
    pill: null,
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 3 });
  assert.equal(reloads.length, 0);
  assert.equal(stats.seeNewPosts, 0);
  const lied = shortFeedAbortReason(stats);
  assert.equal(/click/i.test(lied), false);
});

test("Kapil dump: new posts is an empty feed button whose parent has the box", async () => {
  const cardKey = "expandedyjZ_npz2OvCjcc-knVQNOA_z5x-N76KcYhDV5vzb0jEFeedType_MAIN_FEED_RELEVANCE";
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div data-rect="newposts-wrap">
          <button data-rect="newposts-btn" aria-label="New posts"></button>
        </div>
        <button data-rect="adani">Follow Adani Group Follow</button>
        <button data-rect="axis">Follow Axis Bank Follow</button>
        <button data-rect="hdfc">Follow HDFC Bank Follow</button>
        <div role="listitem" componentkey="${cardKey}">
          Feed post Recommended for you Adani Group Company • Utilities People skilled in Sales also follow these pages Follow Axis Bank
        </div>
      </div>
    </main>
  </body></html>`, {
    "newposts-wrap": { x: 470, y: 140, top: 140, bottom: 176, left: 470, right: 618, width: 148, height: 36 },
    "newposts-btn": { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    adani: { x: 300, y: 400, top: 400, bottom: 432, left: 300, right: 460, width: 160, height: 32 },
    axis: { x: 300, y: 440, top: 440, bottom: 472, left: 300, right: 460, width: 160, height: 32 },
    hdfc: { x: 300, y: 480, top: 480, bottom: 512, left: 300, right: 460, width: 160, height: 32 },
    [cardKey]: { x: 300, y: 220, top: 220, bottom: 640, left: 300, right: 840, width: 540, height: 420 },
  });
  const labels = [...world.inspect().buttonLabels];
  assert.deepEqual(labels.slice(0, 4), [
    "new posts",
    "follow adani group follow",
    "follow axis bank follow",
    "follow hdfc bank follow",
  ]);
  const wrap = document.querySelector("[data-rect='newposts-wrap']");
  document.elementFromPoint = () => wrap;
  const found = world.findSeeNewPosts();
  assert.ok(found, "dump-shaped new posts button produced no click point");
  assert.equal(found.tag, "div");
  assert.equal(found.box.width, 148);
  assert.equal(found.box.height, 36);
  assert.equal(world.probe(found.x, found.y, "see-new").safe, true);
  const followButtons = [...document.querySelectorAll("[data-rect='adani'], [data-rect='axis'], [data-rect='hdfc']")];
  document.elementFromPoint = (x, y) => followButtons.find((el) => {
    const r = el.getBoundingClientRect();
    return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  }) || null;

  const reloads = [];
  const gotos = [];
  const clicks = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async (options) => { reloads.push(options); },
    goto: async (url) => { gotos.push(url); },
    evaluate: async (fn, ...args) => vm.runInNewContext(
      `(${fn.toString()})(...args)`,
      {
        document,
        window: { innerHeight: 900, innerWidth: 1280 },
        location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
        getComputedStyle: () => ({ visibility: "visible" }),
        URL,
        args,
      },
    ),
  };
  const stats = { postsSeen: 1, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0, seeNewPostsAtRecovery: 0 };
  await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async (x, y, kind) => {
      clicks.push({ x, y, kind });
      return true;
    },
  }, stats, {
    postsSeen: 1,
    maxTop: 273,
    firstTop: 196,
    visibleUpdates: 7,
    url: page.url(),
    pill: null,
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 1, followGate: pressAll });
  assert.equal(stats.seeNewPosts, 0);
  assert.deepEqual(gotos, []);
  assert.equal(reloads.length, 0);
  assert.equal(clicks.length, 3);
  assert.deepEqual(clicks.map((click) => click.kind), ["thin-follow", "thin-follow", "thin-follow"]);
  assert.equal(/click/i.test(shortFeedAbortReason(stats)), false);
});

test("a short feed hard-refreshes when the new posts button has no box", async () => {
  const keys = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    keyboard: {
      down: async (key) => { keys.push(`down:${key}`); },
      up: async (key) => { keys.push(`up:${key}`); },
      press: async (key) => { keys.push(`press:${key}`); },
    },
  };
  const stats = { postsSeen: 3, feedUrlLoads: 0, seeNewPosts: 0, seeNewPostsAtRecovery: 0, seeNewMisses: 0 };
  const loaded = await hardRefreshFeed(page, stats, { pause: async () => {} });
  assert.equal(loaded, true);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  assert.deepEqual(keys, [`down:${modifier}`, "down:Shift", "press:KeyR", "up:Shift", `up:${modifier}`]);
  assert.equal(stats.feedUrlLoads, 1);
});

test("a short feed follows the person through the gate, never the company, then re-counts posts", async () => {
  const peopleOptimizer = {
    plan: { followCap: 1 },
    reserved: [],
    gateFollow: ({ candidate }) => ({ allow: /\/in\//.test(candidate.profileUrl) }),
    reserveFollow(candidate) { this.reserved.push(candidate.profileUrl); return "a1"; },
    finishFollow: () => {},
  };
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed">
        <div data-rect="person-row">
          <a href="https://www.linkedin.com/in/jane-doe/">Jane Doe</a>
          <button data-rect="person-follow" aria-label="Follow Jane Doe">Follow</button>
        </div>
        <div data-rect="company-row">
          <a href="https://www.linkedin.com/company/adani-group/">Adani Group</a>
          <button data-rect="company-follow" aria-label="Follow Adani Group">Follow</button>
        </div>
        <button data-rect="already" aria-label="Following Axis Bank">Following</button>
        <button data-rect="more">Show more</button>
        <div data-rect="ad-row">Promoted
          <a href="https://www.linkedin.com/company/hdfc-bank/">HDFC Bank</a>
          <button data-rect="ad-follow" aria-label="Follow HDFC Bank">Follow</button>
        </div>
      </div>
    </main>
  </body></html>`, {
    "person-follow": { x: 480, y: 220, top: 220, bottom: 252, left: 480, right: 600, width: 120, height: 32 },
    "company-follow": { x: 480, y: 280, top: 280, bottom: 312, left: 480, right: 600, width: 120, height: 32 },
    already: { x: 480, y: 340, top: 340, bottom: 372, left: 480, right: 600, width: 120, height: 32 },
    more: { x: 480, y: 400, top: 400, bottom: 432, left: 480, right: 600, width: 120, height: 32 },
    "ad-follow": { x: 480, y: 460, top: 460, bottom: 492, left: 480, right: 600, width: 120, height: 32 },
    "ad-row": { x: 300, y: 440, top: 440, bottom: 520, left: 300, right: 840, width: 540, height: 80 },
  });
  document.elementFromPoint = (x, y) => {
    const hits = [...document.querySelectorAll("button")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 8 && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    });
    return hits[0] || null;
  };
  const healthy = world.followCandidates().map((item) => item.profileUrl);
  assert.equal(healthy.some((url) => url.includes("/company/")), false);
  const found = [...world.thinFeedFollows()];
  assert.deepEqual(found.map((item) => item.kind), ["person", "company"]);
  assert.equal(found[1].name, "Adani Group");

  const clicks = [];
  const counts = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async () => { throw new Error("short feed must follow, not reload"); },
    goto: async () => { throw new Error("goto"); },
    keyboard: { press: async () => {} },
    evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
      document,
      window: { innerHeight: 900, innerWidth: 1280 },
      location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
      getComputedStyle: () => ({ visibility: "visible" }),
      URL,
      args,
    }),
  };
  const stats = { postsSeen: 1, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 };
  const result = await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async (x, y, kind, url) => {
      clicks.push({ x, y, kind, url });
      return true;
    },
  }, stats, {
    postsSeen: 1,
    maxTop: 273,
    firstTop: 196,
    visibleUpdates: 6,
    url: page.url(),
    pill: null,
  }, {
    pause: async () => {},
    waitMs: 0,
    followGate: thinFollowGate(peopleOptimizer, { started: 0 }),
    countUnique: async () => {
      counts.push(clicks.length);
      return clicks.length ? 4 : 1;
    },
  });
  assert.deepEqual(clicks.map((click) => click.kind), ["thin-follow"], "the company Follow is not pressed");
  assert.equal(clicks[0].url, "https://www.linkedin.com/in/jane-doe/");
  assert.deepEqual(peopleOptimizer.reserved, ["https://www.linkedin.com/in/jane-doe/"]);
  assert.equal(stats.followAttempts, 1);
  assert.ok(counts.length >= 1);
  assert.equal(result.postsSeen, 4);
  assert.equal(stats.postsSeen, 4);
});

test("a thin-feed press lands on the Follow button, not the name link or More", async () => {
  const follow = { x: 620, y: 200, top: 200, bottom: 232, left: 620, right: 692, width: 72, height: 32 };
  const name = { x: 300, y: 150, top: 150, bottom: 174, left: 300, right: 480, width: 180, height: 24 };
  const more = { x: 800, y: 120, top: 120, bottom: 148, left: 800, right: 836, width: 36, height: 28 };
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed">
        <div data-rect="card">
          <a data-rect="name" href="https://www.linkedin.com/company/adani-group/">
            Adani Group
            <button data-rect="follow-btn" aria-label="Follow Adani Group"><span data-rect="follow-word">Follow</span></button>
          </a>
          <button data-rect="more-btn" aria-label="More">More</button>
        </div>
      </div>
    </main>
  </body></html>`, {
    card: { x: 280, y: 140, top: 140, bottom: 280, left: 280, right: 860, width: 580, height: 140 },
    name,
    "follow-btn": { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    "follow-word": follow,
    "more-btn": more,
  });
  const contains = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  const followWord = document.querySelector("[data-rect='follow-word']");
  const nameLink = document.querySelector("[data-rect='name']");
  const moreButton = document.querySelector("[data-rect='more-btn']");
  document.elementFromPoint = (x, y) => {
    if (contains(follow, x, y)) return followWord;
    if (contains(more, x, y)) return moreButton;
    if (contains(name, x, y)) return nameLink;
    return null;
  };
  const targets = [...world.thinFeedFollows()];
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, "company");
  assert.equal(targets[0].name, "Adani Group");
  assert.equal(contains(follow, targets[0].x, targets[0].y), true);
  assert.equal(contains(name, targets[0].x, targets[0].y), false);
  assert.equal(contains(more, targets[0].x, targets[0].y), false);
  assert.equal(world.probe(targets[0].x, targets[0].y, "thin-follow", targets[0].url).safe, true);
  assert.equal(world.probe(name.x + 20, name.y + 8, "thin-follow", targets[0].url).safe, false);
  assert.equal(world.probe(more.x + 10, more.y + 10, "thin-follow", targets[0].url).safe, false);

  const clicks = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async () => { throw new Error("reload"); },
    keyboard: { press: async () => {} },
    evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
      document,
      window: { innerHeight: 900, innerWidth: 1280 },
      location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
      getComputedStyle: () => ({ visibility: "visible" }),
      URL,
      args,
    }),
  };
  await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async (x, y, kind, url) => {
      clicks.push({ x, y, kind, url });
      return true;
    },
  }, { postsSeen: 1, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
    postsSeen: 1,
    maxTop: 273,
    firstTop: 196,
    visibleUpdates: 4,
    url: page.url(),
    pill: null,
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 1, followGate: pressAll });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].kind, "thin-follow");
  assert.equal(contains(follow, clicks[0].x, clicks[0].y), true);
  assert.equal(contains(name, clicks[0].x, clicks[0].y), false);
  assert.equal(contains(more, clicks[0].x, clicks[0].y), false);
});

test("a Follow button under the right rail is not pressed, and a clear Follow button is", async () => {
  const rail = { x: 780, y: 80, top: 80, bottom: 780, left: 780, right: 1060, width: 280, height: 700 };
  const adani = { x: 820, y: 240, top: 240, bottom: 272, left: 820, right: 908, width: 88, height: 32 };
  const osama = { x: 420, y: 320, top: 320, bottom: 352, left: 420, right: 508, width: 88, height: 32 };
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed" data-rect="column">
        <button data-rect="adani" aria-label="Follow Adani Group">Follow</button>
        <div data-rect="osama-card">
          <a data-rect="osama-link" href="https://www.linkedin.com/in/osama-ibrahem-7637871ba/">Osama Ibrahem</a>
          <button data-rect="osama" aria-label="Follow Osama Ibrahem">Follow</button>
        </div>
      </div>
    </main>
    <aside data-rect="rail">People you may know</aside>
  </body></html>`, {
    column: { x: 200, y: 80, top: 80, bottom: 720, left: 200, right: 720, width: 520, height: 640 },
    adani,
    osama,
    "osama-link": { x: 300, y: 320, top: 320, bottom: 344, left: 300, right: 410, width: 110, height: 24 },
    rail,
  });
  const contains = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  const railNode = document.querySelector("aside");
  const osamaButton = document.querySelector("[data-rect='osama']");
  document.elementFromPoint = (x, y) => {
    if (contains(osama, x, y)) return osamaButton;
    if (contains(adani, x, y) || contains(rail, x, y)) return railNode;
    return null;
  };
  const plan = world.thinFeedFollowPlan();
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].kind, "person");
  assert.equal(plan.ready[0].name, "Osama Ibrahem");
  assert.equal(plan.ready[0].url, "https://www.linkedin.com/in/osama-ibrahem-7637871ba/");
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].name, "Adani Group");
  assert.match(plan.blocked[0].hitLabel, /people you may know/i);
  assert.equal(world.probe(adani.x + adani.width / 2, adani.y + adani.height / 2, "thin-follow").safe, false);
  assert.equal(world.probe(osama.x + osama.width / 2, osama.y + osama.height / 2, "thin-follow", plan.ready[0].url).safe, true);

  const clicks = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async () => { throw new Error("reload"); },
    keyboard: { press: async () => {} },
    evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
      document,
      window: { innerHeight: 900, innerWidth: 1280 },
      location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
      getComputedStyle: () => ({ visibility: "visible" }),
      URL,
      args,
    }),
  };
  await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async (x, y, kind, url) => {
      clicks.push({ x, y, kind, url });
      return true;
    },
  }, { postsSeen: 2, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
    postsSeen: 2,
    maxTop: 273,
    firstTop: 196,
    visibleUpdates: 2,
    url: page.url(),
    pill: null,
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 2, followGate: pressAll });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].kind, "thin-follow");
  assert.equal(clicks[0].url, "https://www.linkedin.com/in/osama-ibrahem-7637871ba/");
  assert.equal(contains(osama, clicks[0].x, clicks[0].y), true);
  assert.equal(contains(adani, clicks[0].x, clicks[0].y), false);
  assert.equal(contains(rail, clicks[0].x, clicks[0].y), false);
});

test("an in-viewport Follow at the right of the feed is pressed with the pointer", async () => {
  const pill = { x: 878.5, y: 254, top: 254, bottom: 302, left: 878.5, right: 958, width: 79.5, height: 48 };
  const { document, world } = feedWorld(`<!doctype html><html><body>
    <main>
      <div data-testid="mainFeed" data-rect="column">
        <div data-rect="card">
          <a data-rect="name" href="https://www.linkedin.com/in/someone-else/">Someone Else</a>
          <button data-rect="follow" aria-label="Follow Someone Else">Follow</button>
        </div>
      </div>
    </main>
  </body></html>`, {
    column: { x: 200, y: 80, top: 80, bottom: 800, left: 200, right: 1100, width: 900, height: 720 },
    card: { x: 700, y: 200, top: 200, bottom: 360, left: 700, right: 1000, width: 300, height: 160 },
    name: { x: 720, y: 220, top: 220, bottom: 244, left: 720, right: 860, width: 140, height: 24 },
    follow: pill,
  });
  const button = document.querySelector("[data-rect='follow']");
  const domClicks = [];
  button.click = () => { domClicks.push("element.click"); };
  const contains = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  document.elementFromPoint = (x, y) => (contains(pill, x, y) ? button : null);
  const ready = [...world.thinFeedFollows()];
  assert.equal(ready.length, 1);
  assert.equal(ready[0].name, "Someone Else");
  assert.equal(contains(pill, ready[0].x, ready[0].y), true);
  const clicks = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async () => { throw new Error("reload"); },
    keyboard: { press: async () => {} },
    evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, {
      document,
      window: { innerHeight: 836, innerWidth: 1470 },
      location: { href: "https://www.linkedin.com/feed/", origin: "https://www.linkedin.com" },
      getComputedStyle: () => ({ visibility: "visible" }),
      URL,
      args,
    }),
  };
  await actOnShortColumn(page, {
    postsCacheAt: 0,
    clickAt: async (x, y, kind, url) => {
      clicks.push({ x, y, kind, url });
      return true;
    },
  }, { postsSeen: 3, feedUrlLoads: 0, seeNewMisses: 0, seeNewPosts: 0 }, {
    postsSeen: 3,
    maxTop: 273,
    firstTop: 196,
    visibleUpdates: 3,
    url: page.url(),
    pill: null,
  }, { pause: async () => {}, waitMs: 0, countUnique: async () => 3, followGate: pressAll });
  assert.equal(domClicks.length, 0);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].kind, "thin-follow");
  assert.equal(contains(pill, clicks[0].x, clicks[0].y), true);
});

test("a connection-closed feed load is retried and never reloads the document", async () => {
  const events = [];
  let fails = 2;
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async () => { events.push("reload"); },
    goto: async (url) => {
      events.push(`goto:${url}`);
      if (fails > 0) {
        fails -= 1;
        throw new Error("net::ERR_CONNECTION_CLOSED at https://www.linkedin.com/feed/");
      }
      page.href = url;
    },
  };
  const stats = { postsSeen: 3 };
  assert.equal(await loadRealFeed(page, stats, { pause: async () => {} }), true);
  assert.equal(events.includes("reload"), false);
  assert.equal(events.filter((event) => event.startsWith("goto:")).length, 3);
  assert.equal(stats.connectionClosed, undefined);
  assert.equal(stats.feedUrlLoads, 1);
});

test("three connection-closed loads do not abort a feed that already had posts", async () => {
  const events = [];
  const page = {
    href: "https://www.linkedin.com/feed/",
    url() { return page.href; },
    reload: async () => { events.push("reload"); },
    goto: async () => {
      events.push("goto");
      throw new Error("net::ERR_CONNECTION_CLOSED at https://www.linkedin.com/feed/");
    },
  };
  const stats = { postsSeen: 3 };
  assert.equal(await loadRealFeed(page, stats, { pause: async () => {} }), false);
  assert.equal(events.includes("reload"), false);
  assert.equal(events.length, 3);
  assert.equal(stats.connectionClosed, true);
  assert.equal(shouldAbortFewPosts({ postsSeen: 3, connectionClosed: true }), false);
  assert.equal(shouldAbortFewPosts({ postsSeen: 0, connectionClosed: true }), true);
  assert.equal(shouldAbortFewPosts({ postsSeen: 3 }), true);
});

function settledFeed(overrides = {}) {
  return {
    readyState: "complete",
    pendingImages: 0,
    skeletons: 0,
    feedHeight: 1600,
    railText: 240,
    railControls: 8,
    ...overrides,
  };
}

const paintedRails = `<main id="workspace">
  <aside id="left">
    LinkedIn News. Top stories from your network and the companies you follow this week.
    <a href="/newsletters/">Newsletters</a>
    <a href="/events/">Events</a>
    <a href="/groups/">Groups</a>
    <button type="button">Follow</button>
  </aside>
  <div data-testid="mainFeed" id="feed"></div>
  <aside id="right">People you may know from your industry are showing up on the right rail today.</aside>
</main>`;

const bareRails = `<main id="workspace">
  <aside id="left"><a href="/newsletters/">Newsletters</a> <a href="/events/">Events</a></aside>
  <div data-testid="mainFeed" id="feed"></div>
  <aside id="right"></aside>
</main>`;

function loadSnapshot(html, rects = {}, prepare) {
  const { document, world } = feedWorld(html, rects);
  prepare?.(document);
  return world.feedLoadSnapshot();
}

test("a pending in-view image holds for images, and a finished image does not", () => {
  const pending = loadSnapshot(paintedRails.replace("</div>", `<img id="photo" alt=""></div>`), {}, (document) => {
    const img = document.querySelector("#photo");
    img.complete = false;
    img.naturalWidth = 0;
  });
  assert.ok(pending.pendingImages >= 1);
  assert.equal(scrollHoldReason(pending), "images");

  const broken = loadSnapshot(paintedRails.replace("</div>", `<div id="wrap" class="ghost-person"><img id="photo" class="ghost-person" alt=""></div></div>`), {}, (document) => {
    const img = document.querySelector("#photo");
    img.complete = true;
    img.naturalWidth = 0;
  });
  assert.equal(broken.pendingImages, 0);
  assert.equal(broken.skeletons, 0);
  assert.equal(scrollHoldReason(broken), null);
  assert.equal(scrollHoldReason(settledFeed({ pendingImages: 0 })), null);
});

test("tiny or offscreen images are not an image hold", () => {
  const snap = loadSnapshot(
    paintedRails.replace("</div>", `<img id="tiny" alt=""><img id="below" alt=""></div>`),
    {
      tiny: { x: 420, y: 200, top: 200, bottom: 216, left: 420, right: 436, width: 16, height: 16 },
      below: { x: 420, y: 1400, top: 1400, bottom: 1480, left: 420, right: 500, width: 80, height: 80 },
    },
    (document) => {
      document.querySelector("#tiny").complete = false;
      document.querySelector("#below").complete = false;
    },
  );
  assert.equal(snap.pendingImages, 0);
  assert.equal(scrollHoldReason(snap), null);
});

test("in-view aria-busy, loader, and ghost markers hold for skeleton", () => {
  const html = `${paintedRails.slice(0, paintedRails.indexOf("</main>"))}
    <div id="ghost" class="ghost-placeholder"></div>
    <div id="busy" aria-busy="true"></div>
    <div id="loader" class="artdeco-loader"></div>
    <div id="below" class="feed-skeleton"></div>
    <div id="flat" class="feed-skeleton"></div>
  </main>`;
  const snap = loadSnapshot(html, {
    below: { x: 420, y: 1400, top: 1400, bottom: 1480, left: 420, right: 620, width: 200, height: 80 },
    flat: { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
  });
  assert.equal(snap.skeletons, 3);
  assert.equal(scrollHoldReason(snap), "skeleton");
  assert.equal(scrollHoldReason(settledFeed({ skeletons: 1 })), "skeleton");
});

test("scroll hold reasons follow the loading snapshot and ignore a settled feed", () => {
  assert.equal(scrollHoldReason(settledFeed({ readyState: "interactive" })), null, "a painted SPA can sit at interactive");
  assert.equal(scrollHoldReason(settledFeed({ readyState: "loading", pendingImages: 4, skeletons: 2, railText: 0, railControls: 0, feedHeight: 200 })), "document");
  assert.equal(scrollHoldReason(settledFeed({ pendingImages: 1 })), "images");
  assert.equal(scrollHoldReason(settledFeed({ skeletons: 2 })), "skeleton");
  assert.equal(scrollHoldReason(settledFeed({ feedHeight: 941 }), settledFeed({ feedHeight: 900 })), "posts-growing");
  assert.equal(scrollHoldReason(settledFeed({ feedHeight: 940 }), settledFeed({ feedHeight: 900 })), null);
  assert.equal(scrollHoldReason(settledFeed({ feedHeight: 2000 })), null);
  assert.equal(scrollHoldReason(settledFeed({ railText: 18, railControls: 2, feedHeight: 480 })), "rails");
  assert.equal(scrollHoldReason(settledFeed({ railText: 18, railControls: 2, feedHeight: 1400 })), null);
  assert.equal(scrollHoldReason(settledFeed({ railText: 80, railControls: 0, feedHeight: 200 })), null);
  assert.equal(scrollHoldReason(settledFeed({ railText: 10, railControls: 3, feedHeight: 200 })), null);
  assert.equal(scrollHoldReason(settledFeed({ railText: 10, railControls: 1, feedHeight: 900 })), null);
  assert.equal(scrollHoldReason(settledFeed()), null);
  assert.equal(scrollHoldReason(null), null);
});

test("empty rails on a short feed hold, and empty rails on a tall settled feed do not", () => {
  const short = loadSnapshot(bareRails, {
    feed: { x: 411, y: 80, top: 80, bottom: 560, left: 411, right: 963, width: 552, height: 480 },
  });
  assert.ok(short.railText < 80);
  assert.ok(short.railControls < 3);
  assert.ok(short.feedHeight < 900);
  assert.equal(scrollHoldReason(short), "rails");

  const tall = loadSnapshot(bareRails, {
    feed: { x: 411, y: 80, top: 80, bottom: 1480, left: 411, right: 963, width: 552, height: 1400 },
  });
  assert.ok(tall.railText < 80);
  assert.ok(tall.railControls < 3);
  assert.ok(tall.feedHeight >= 900);
  assert.equal(tall.pendingImages, 0);
  assert.equal(tall.skeletons, 0);
  assert.equal(scrollHoldReason(tall), null);
});

test("a ready document with rails and no pending media does not hold", () => {
  const snap = loadSnapshot(paintedRails, {
    feed: { x: 411, y: 80, top: 80, bottom: 1680, left: 411, right: 963, width: 552, height: 1600 },
  }, (document) => {
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
  });
  assert.equal(snap.readyState, "complete");
  assert.equal(snap.pendingImages, 0);
  assert.equal(snap.skeletons, 0);
  assert.ok(snap.railText >= 80);
  assert.ok(snap.railControls >= 3);
  assert.equal(scrollHoldReason(snap), null);
});

test("four still-loading scrolls end the feed step and are not stuck scrolls", () => {
  const stats = { stuck: 6, loadingPasses: 0 };
  const held = { held: true, stillLoading: true, reason: "images", moved: 0, ticks: 0, fallback: false };
  for (let pass = 1; pass <= 3; pass += 1) {
    const pace = noteStillLoadingScroll(stats, held);
    assert.equal(pace.stop, false);
    assert.equal(pace.held, true);
    assert.equal(stats.stuck, 0);
    assert.equal(stats.loadingPasses, pass);
  }
  const stop = noteStillLoadingScroll(stats, { ...held, reason: "rails" });
  assert.equal(stop.stop, true);
  assert.equal(stop.reason, "Feed stayed on a loading screen");
  assert.equal(stats.loadingPasses, 4);
  assert.equal(stats.stuck, 0);

  const cleared = { stuck: 2, loadingPasses: 3 };
  assert.equal(noteStillLoadingScroll(cleared, { moved: 180 }).stop, false);
  assert.equal(cleared.loadingPasses, 0);
  assert.equal(cleared.stuck, 2);
});

function liveFeedPage(methodResult) {
  return {
    url: () => "https://www.linkedin.com/feed/",
    evaluate: async (_fn, _world, _helpers, method) => methodResult(method),
  };
}

test("scrollFeed does not wheel while the feed snapshot is still loading", async () => {
  const pauses = [];
  const wheels = [];
  const page = liveFeedPage((method) => {
    if (method === "columnState") return { visibleUpdates: 4, feedVisible: true, feedHeight: 420, railText: 18, maxTop: 273, top: 0 };
    if (method === "feedLoadSnapshot") {
      return {
        readyState: "complete",
        pendingImages: 2,
        skeletons: 0,
        feedHeight: 420,
        railText: 18,
        railControls: 2,
      };
    }
    return null;
  });
  const human = new HumanController(page);
  human.pointer = { x: 480, y: 300, coords: () => ({ x: 480, y: 300 }), wheel: async (delta) => wheels.push(delta), move: async () => {} };
  const result = await human.scrollFeed({ reverseChance: 0, pause: async (min, max) => { pauses.push([min, max]); } });
  assert.equal(wheels.length, 0);
  assert.equal(pauses.length, 4);
  assert.deepEqual(pauses[0], [1200, 2500]);
  assert.equal(result.held, true);
  assert.equal(result.stillLoading, true);
  assert.equal(result.reason, "images");
  assert.equal(result.moved, 0);
  assert.equal(result.ticks, 0);
  assert.equal(result.fallback, false);
});

test("a blank live feed still returns empty without waiting or wheeling", async () => {
  const pauses = [];
  const wheels = [];
  let snapshots = 0;
  const page = liveFeedPage((method) => {
    if (method === "columnState") return { visibleUpdates: 0, feedHeight: 0, railText: 0 };
    if (method === "feedLoadSnapshot") {
      snapshots += 1;
      return { readyState: "loading", pendingImages: 3, skeletons: 1, feedHeight: 80, railText: 0, railControls: 0 };
    }
    return null;
  });
  const human = new HumanController(page);
  human.pointer = { wheel: async (delta) => wheels.push(delta), x: 1, y: 1, coords: () => ({ x: 1, y: 1 }) };
  const result = await human.scrollFeed({ reverseChance: 0, pause: async (...args) => pauses.push(args) });
  assert.equal(result.empty, true);
  assert.equal(wheels.length, 0);
  assert.equal(pauses.length, 0);
  assert.equal(snapshots, 0);
});

test("scrollFeed wheels once the loading hold clears", async () => {
  const pauses = [];
  const wheels = [];
  let shots = 0;
  const page = liveFeedPage((method) => {
    if (method === "columnState") return { visibleUpdates: 4, feedVisible: true, feedHeight: 1600, railText: 240 };
    if (method === "feedLoadSnapshot") {
      shots += 1;
      if (shots < 3) {
        return { readyState: "interactive", pendingImages: 0, skeletons: 0, feedHeight: 500, railText: 240, railControls: 8 };
      }
      return { readyState: "complete", pendingImages: 0, skeletons: 0, feedHeight: 500, railText: 240, railControls: 8 };
    }
    if (method === "wheelAnchor") return null;
    return null;
  });
  const human = new HumanController(page);
  human.pointer = {
    dead: false,
    x: 480,
    y: 300,
    coords: () => ({ x: 480, y: 300 }),
    wheel: async (delta) => wheels.push(delta),
    move: async () => {},
  };
  human.ensureOverFeed = async () => {};
  human.followContent = async () => {};
  let reads = 0;
  human.scrollOffset = async () => {
    reads += 1;
    return { top: reads < 4 ? 100 : 420, maxTop: 3000, firstUrn: "fixture", firstTop: reads < 4 ? 200 : -120 };
  };
  const result = await human.scrollFeed({ reverseChance: 0, pause: async (min, max) => { pauses.push([min, max]); } });
  assert.equal(shots, 3);
  assert.equal(pauses.length, 2);
  assert.deepEqual(pauses[0], [1200, 2500]);
  assert.equal(wheels.length, 1);
  assert.ok(wheels[0] > 100 && wheels[0] <= 260);
  assert.equal(result.held, undefined);
  assert.equal(result.fallback, false);
  assert.equal(result.moved, 320);
});


// Dharmendra Undefined, 2026-10-11 16:39:46Z: held on "document" for three full passes.
const DHARMENDRA_FIRST = { readyState: "interactive", pendingImages: 0, skeletons: 0, feedHeight: 2303, railText: 857, railControls: 42 };
const DHARMENDRA_GROWN = { ...DHARMENDRA_FIRST, feedHeight: 5991 };
const preFixHoldReason = (snapshot) => (snapshot.readyState && snapshot.readyState !== "complete" ? "document" : null);

test("Dharmendra: a painted feed at readyState interactive is not held", () => {
  assert.equal(preFixHoldReason(DHARMENDRA_FIRST), "document", "the old rule held this snapshot");
  assert.equal(preFixHoldReason(DHARMENDRA_GROWN), "document");
  assert.equal(feedLooksPainted(DHARMENDRA_FIRST), true);
  assert.equal(scrollHoldReason(DHARMENDRA_FIRST), null);
  assert.equal(scrollHoldReason(DHARMENDRA_GROWN, DHARMENDRA_GROWN), null);
  assert.equal(scrollHoldReason(DHARMENDRA_GROWN, DHARMENDRA_FIRST), "posts-growing", "the 2303 to 5991 jump is still growth");
});

test("Dharmendra: the 2303 to 5991 jump settles after one growth wait and then wheels", async () => {
  const shots = [{ ...DHARMENDRA_FIRST, skeletons: 1 }, DHARMENDRA_GROWN, DHARMENDRA_GROWN, DHARMENDRA_GROWN];
  let read = 0;
  const pauses = [];
  const wheels = [];
  const page = liveFeedPage((method) => {
    if (method === "columnState") return { visibleUpdates: 2, feedVisible: true, feedHeight: 5991, railText: 857 };
    if (method === "feedLoadSnapshot") return shots[Math.min(read++, shots.length - 1)];
    return null;
  });
  const human = new HumanController(page);
  human.pointer = { dead: false, x: 480, y: 300, coords: () => ({ x: 480, y: 300 }), wheel: async (delta) => wheels.push(delta), move: async () => {} };
  human.ensureOverFeed = async () => {};
  let offsets = 0;
  human.scrollOffset = async () => ({ top: (offsets += 1) < 3 ? 0 : 200, maxTop: 5352, firstUrn: "fixture", firstTop: offsets < 3 ? 224 : 24 });
  const result = await human.scrollFeed({ reverseChance: 0, pause: async (...args) => pauses.push(args) });
  assert.equal(read, 3, "skeleton sample, one growth sample, then a settled sample");
  assert.equal(pauses.length, 2);
  assert.equal(wheels.length, 1);
  assert.equal(result.held, undefined);
});

test("a held pass on a painted page does not count toward the loading-screen stop, up to a cap", () => {
  const stats = { stuck: 3, loadingPasses: 0 };
  const held = { held: true, stillLoading: true, reason: "posts-growing", before: DHARMENDRA_GROWN };
  for (let pass = 1; pass <= PAINTED_HOLD_LIMIT; pass += 1) {
    const pace = noteStillLoadingScroll(stats, held);
    assert.equal(pace.held, true);
    assert.equal(pace.stop, false);
  }
  assert.equal(stats.loadingPasses, 0);
  for (let pass = 1; pass < FEED_LOADING_PASS_LIMIT; pass += 1) noteStillLoadingScroll(stats, held);
  assert.equal(noteStillLoadingScroll(stats, held).stop, true, "a page that never stops growing still ends the feed step");
});

test("a genuinely loading interactive page (short feed, empty rails) still holds and counts", async () => {
  const loading = { readyState: "interactive", pendingImages: 0, skeletons: 0, feedHeight: 480, railText: 18, railControls: 2 };
  assert.equal(scrollHoldReason(loading), "document");
  assert.equal(scrollHoldReason(loading, loading), "document");
  assert.equal(scrollHoldReason({ ...DHARMENDRA_FIRST, feedHeight: 600 }), "document", "a short column at interactive holds");
  assert.equal(scrollHoldReason({ ...DHARMENDRA_FIRST, railText: 10, railControls: 1 }), "document", "empty rails at interactive hold");
  assert.equal(scrollHoldReason({ ...DHARMENDRA_FIRST, pendingImages: 2 }), "images", "pending media on a painted page holds once, as images");
  assert.equal(scrollHoldReason({ ...DHARMENDRA_FIRST, pendingImages: 2 }, DHARMENDRA_FIRST), null, "but not on every sample of a painted page");
  assert.equal(scrollHoldReason({ ...loading, readyState: "loading" }), "document", "an unpainted loading document holds");
  assert.equal(scrollHoldReason({ ...loading, readyState: "loading", feedHeight: 4000, railText: 900, railControls: 40 }), null, "a painted loading document does not");

  const pauses = [];
  const wheels = [];
  const page = liveFeedPage((method) => {
    if (method === "columnState") return { visibleUpdates: 1, feedVisible: true, feedHeight: 480, railText: 18 };
    if (method === "feedLoadSnapshot") return loading;
    return null;
  });
  const human = new HumanController(page);
  human.pointer = { x: 480, y: 300, coords: () => ({ x: 480, y: 300 }), wheel: async (delta) => wheels.push(delta), move: async () => {} };
  const result = await human.scrollFeed({ reverseChance: 0, pause: async (...args) => pauses.push(args) });
  assert.equal(result.stillLoading, true);
  assert.equal(result.reason, "document");
  assert.equal(wheels.length, 0);
  assert.equal(pauses.length, 4);
  const stats = { stuck: 0, loadingPasses: 0 };
  noteStillLoadingScroll(stats, result);
  assert.equal(stats.loadingPasses, 1);
});

// Analyst finding 2: "commentsSectionContainer<id>FeedType_..." and "...-asyncInlineCommentBoxSlot0_..."
// were collected as posts of their own, with their own expand and dwell, inflating postsSeen.
test("comment sections and inline comment boxes are part of their post, not extra posts", () => {
  const id = "XsahbNJs1-FZ6hoR2UF4AqHdt9f0m1Lr27kbUctdE-8FeedType_MAIN_FEED_RELEVANCE";
  const other = "jJGxbv6MtYPa8eTd6hluuBhrd2K29yjIVn3p8aQHUwYFeedType_MAIN_FEED_RELEVANCE";
  const bar = (who) => `<button aria-label="Open control menu for post by ${who}"></button>
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>`;
  const box = (top) => ({ x: 300, y: top, top, bottom: top + 300, width: 540, height: 300, left: 300, right: 840 });
  const { world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expanded${id}">A long post by Asha with a lot of text. ${bar("Asha")}</div>
        <div componentkey="commentsSectionContainer${id}">Ravi: great point. <button aria-label="Reaction button state: no reaction Like">Like</button> <button aria-label="Comment">Comment</button> Reply</div>
        <div componentkey="${id}-asyncInlineCommentBoxSlot0_abc">Add a comment… <button aria-label="Comment">Comment</button> like repost</div>
        <div role="listitem" componentkey="${other}">Another post by Meera. ${bar("Meera")}</div>
      </div>
    </main>
  </body></html>`, {
    [`expanded${id}`]: box(120),
    [`commentsSectionContainer${id}`]: box(430),
    [`${id}-asyncInlineCommentBoxSlot0_abc`]: box(520),
    [other]: box(560),
  });
  const urns = world.collect().map((post) => post.urn);
  assert.deepEqual([...urns].sort(), [id, other].sort());
  assert.ok(urns.every((urn) => !/commentsSection|CommentBox/.test(urn)));
});

test("a comment key nested inside its post resolves to the post's base identity", () => {
  const id = "Nly9pqLzFGxV_FmLHo2Qtslv-L1Fcvq_pP1IYmiRqTUFeedType_MAIN_FEED_RELEVANCE";
  const { world } = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="update-card-focus${id}">Post text by Kiran.
          <button aria-label="Open control menu for post by Kiran"></button>
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>
          <div componentkey="commentsSectionContainer${id}">A reply. <button aria-label="Comment">Comment</button></div>
        </div>
      </div>
    </main>
  </body></html>`);
  const posts = world.collect();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].urn, id);
});

// Sikandar Rathore 18:19:53Z: "Stayed on a post" on
// "CgsIgIC4/Inik8nQAQ-asyncInlineCommentBoxSlotBC3krKneo6O5...FeedType_MAIN_FEED_RELEVANCE",
// the comment box of a post expanded 32s earlier. The post URN sits after the marker.
test("Sikandar: a comment-box wrapper whose key ends in the post URN is part of that post", () => {
  const id = "BC3krKneo6O5Bc4aki365imyzN6_AX55G67OGVLOvbcFeedType_MAIN_FEED_RELEVANCE";
  const wrapper = `CgsIgIC4/Inik8nQAQ-asyncInlineCommentBoxSlot${id}`;
  const commentItem = `<div role="listitem">Neha: congratulations!
            <button aria-label="Reaction button state: no reaction Like">Like</button>
            <button aria-label="Comment">Comment</button> Reply</div>`;
  const nested = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expanded${id}">A post by Arjun with enough text to read.
          <button aria-label="Open control menu for post by Arjun"></button>
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>
          <div componentkey="${wrapper}">${commentItem}</div>
        </div>
      </div>
    </main>
  </body></html>`);
  const nestedUrns = [...nested.world.collect().map((post) => post.urn)];
  assert.deepEqual(nestedUrns, [id]);

  const sibling = feedWorld(`<!doctype html><html><body>
    <main id="workspace">
      <div data-testid="mainFeed" role="list">
        <div role="listitem" componentkey="expanded${id}">A post by Arjun with enough text to read.
          <button aria-label="Open control menu for post by Arjun"></button>
          <button aria-label="Reaction button state: no reaction Like">Like</button>
          <button aria-label="Comment">Comment</button>
        </div>
        <div componentkey="${wrapper}">${commentItem}</div>
      </div>
    </main>
  </body></html>`, {
    [`expanded${id}`]: { x: 300, y: 120, top: 120, bottom: 420, width: 540, height: 300, left: 300, right: 840 },
    [wrapper]: { x: 300, y: 430, top: 430, bottom: 560, width: 540, height: 130, left: 300, right: 840 },
  });
  const urns = sibling.world.collect().map((post) => post.urn);
  assert.ok(urns.every((urn) => urn === id), urns.join(","));
  assert.equal(new Set(urns).size, 1, "one post, one identity");
});


// Rajendra Soni: one pending image on a tall, painted "interactive" page held as "document".
test("Rajendra: one pending image on a painted interactive page holds as images for one beat, never as document", () => {
  const rajendra = { readyState: "interactive", pendingImages: 1, skeletons: 0, feedHeight: 6009, railText: 823, railControls: 41 };
  assert.equal(scrollHoldReason(rajendra), "images");
  assert.equal(scrollHoldReason(rajendra, rajendra), null, "the next sample of the same painted page scrolls");
  assert.notEqual(scrollHoldReason(rajendra), "document");
});


// Badal Umarwal's retry and Prakash Kharwar's first run: after a feed URL load the document
// stayed "loading" while painted (feed 1740px, rails 873 chars / 41 controls, nothing pending),
// held 12 passes and ended "Feed stayed on a loading screen".
test("Badal: a painted page whose document stays loading is not held and cannot burn the loading stop", async () => {
  const badal = { readyState: "loading", pendingImages: 0, skeletons: 0, feedHeight: 1740, railText: 873, railControls: 41 };
  assert.equal(scrollHoldReason(badal), null);
  assert.equal(scrollHoldReason(badal, badal), null);

  const pauses = [];
  const wheels = [];
  const page = liveFeedPage((method) => {
    if (method === "columnState") return { visibleUpdates: 3, feedVisible: true, feedHeight: 1740, railText: 873 };
    if (method === "feedLoadSnapshot") return badal;
    return null;
  });
  const human = new HumanController(page);
  human.pointer = { dead: false, x: 480, y: 300, coords: () => ({ x: 480, y: 300 }), wheel: async (delta) => wheels.push(delta), move: async () => {} };
  human.ensureOverFeed = async () => {};
  let reads = 0;
  human.scrollOffset = async () => ({ top: (reads += 1) < 3 ? 0 : 200, maxTop: 1100, firstUrn: "fixture", firstTop: reads < 3 ? 200 : 0 });
  const stats = { stuck: 0, loadingPasses: 0 };
  for (let pass = 0; pass < 12; pass += 1) {
    reads = 0;
    const scrolled = await human.scrollFeed({ reverseChance: 0, pause: async (...args) => pauses.push(args) });
    assert.equal(scrolled.held, undefined);
    assert.equal(noteStillLoadingScroll(stats, scrolled).stop, false);
  }
  assert.equal(pauses.length, 0, "no paint waits on a painted page");
  assert.equal(wheels.length, 12);
  assert.equal(stats.loadingPasses, 0);
});
