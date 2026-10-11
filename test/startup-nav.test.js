import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_TAB_ATTEMPTS,
  INITIAL_TAB_WAIT_MS,
  isInitialTab,
  waitForInitialTab,
} from "../src/browser/page.js";
import {
  STARTUP_FEED_ATTEMPTS,
  STARTUP_FEED_URL,
  STARTUP_FEED_WAIT_MS,
  LocalProfileLauncher,
  settleStartupNavigation,
  startupPageKind,
} from "../src/gologin/local.js";
import { failureKind } from "../src/util/failures.js";

function launcher(overrides) {
  let now = 0;
  return new LocalProfileLauncher({
    token: "fixture-token",
    now: () => now,
    pause: async (ms) => { now += ms; },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("start-profile")) {
        return Response.json({ status: "success", wsUrl: "ws://127.0.0.1:9/devtools/browser/fixture" });
      }
      if (href.includes("stop-profile")) return new Response(null, { status: 204 });
      const error = new Error("closed");
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    },
    ...overrides,
  });
}

test("startup retries stay bounded and slower than the old one-second spin", () => {
  assert.ok(INITIAL_TAB_ATTEMPTS >= 2 && INITIAL_TAB_ATTEMPTS <= 5);
  assert.ok(INITIAL_TAB_WAIT_MS >= 8_000);
  assert.equal(STARTUP_FEED_ATTEMPTS, 3);
  assert.ok(STARTUP_FEED_WAIT_MS >= 8_000);
  assert.equal(STARTUP_FEED_URL, "https://www.linkedin.com/feed/");
});

test("no tabs retries with a wait, then fails as infrastructure", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    () => waitForInitialTab(async () => {
      calls += 1;
      return [{ url: "about:blank" }, { url() { return ":"; } }];
    }, {
      attempts: INITIAL_TAB_ATTEMPTS,
      waitMs: INITIAL_TAB_WAIT_MS,
      pause: async (ms) => { waits.push(ms); },
    }),
    (error) => {
      assert.equal(failureKind(error), "infra");
      assert.match(error.message, /no tabs/i);
      assert.match(error.message, /not paused/i);
      assert.equal(error.retainBrowserLock, undefined);
      return true;
    },
  );
  assert.equal(calls, INITIAL_TAB_ATTEMPTS);
  assert.deepEqual(waits, Array(INITIAL_TAB_ATTEMPTS - 1).fill(INITIAL_TAB_WAIT_MS));
  assert.equal(isInitialTab({ url: "chrome-error://chromewebdata/" }), true);
  assert.equal(isInitialTab({ url: "about:blank" }), false);
});

test("a missing debugger listing keeps polling a bounded number of times, then defers to the working-tab check", async () => {
  let calls = 0;
  const waits = [];
  const ready = await waitForInitialTab(async () => {
    calls += 1;
    return null;
  }, { pause: async (ms) => { waits.push(ms); } });
  assert.equal(ready, null);
  assert.equal(calls, INITIAL_TAB_ATTEMPTS);
  assert.equal(waits.length, INITIAL_TAB_ATTEMPTS - 1);
});

test("chrome-error and Gmail get a bounded feed retry", async () => {
  for (const start of ["chrome-error://chromewebdata/", "https://mail.google.com/mail/u/0/", "https://www.bing.com/"]) {
    let url = start;
    const gotos = [];
    const waits = [];
    const result = await settleStartupNavigation({
      listTargets: async () => [{ id: "tab", url }],
      navigate: async (_target, feed) => {
        gotos.push(feed);
        url = "https://www.linkedin.com/feed/";
      },
      pause: async (ms) => { waits.push(ms); },
      attempts: STARTUP_FEED_ATTEMPTS,
      waitMs: STARTUP_FEED_WAIT_MS,
    });
    assert.equal(result.kind, "linkedin");
    assert.equal(result.url, "https://www.linkedin.com/feed/");
    assert.deepEqual(gotos, [STARTUP_FEED_URL]);
    assert.deepEqual(waits, [STARTUP_FEED_WAIT_MS]);
  }
});

test("a detached feed navigation is retried, then the startup gives up on a dead proxy", async () => {
  let url = "https://mail.google.com/mail/u/0/";
  const gotos = [];
  const result = await settleStartupNavigation({
    listTargets: async () => [{ id: "tab", url }],
    navigate: async (_target, feed) => {
      gotos.push(feed);
      if (gotos.length === 1) throw new Error("Navigating frame was detached");
      url = "https://www.linkedin.com/feed/";
    },
    pause: async () => {},
    attempts: STARTUP_FEED_ATTEMPTS,
    waitMs: STARTUP_FEED_WAIT_MS,
  });
  assert.equal(result.kind, "linkedin");
  assert.deepEqual(gotos, [STARTUP_FEED_URL, STARTUP_FEED_URL]);

  const stuck = [];
  await assert.rejects(
    () => settleStartupNavigation({
      listTargets: async () => [{ id: "tab", url: "chrome-error://chromewebdata/" }],
      navigate: async (_target, feed) => { stuck.push(feed); },
      pause: async () => {},
      attempts: STARTUP_FEED_ATTEMPTS,
      waitMs: STARTUP_FEED_WAIT_MS,
    }),
    (error) => {
      assert.equal(failureKind(error), "infra");
      assert.match(error.message, /https:\/\/www\.linkedin\.com\/feed\//);
      assert.match(error.message, /chrome-error:\/\/chromewebdata\//);
      assert.match(error.message, /not paused/i);
      assert.doesNotMatch(error.message, /login required|security challenge/i);
      return true;
    },
  );
  assert.deepEqual(stuck, Array(STARTUP_FEED_ATTEMPTS).fill(STARTUP_FEED_URL));
});

test("a real LinkedIn login or challenge is not treated as a proxy error", async () => {
  const gates = [
    "https://www.linkedin.com/login",
    "https://www.linkedin.com/uas/login",
    "https://www.linkedin.com/checkpoint/challenge/abc",
    "https://www.linkedin.com/authwall",
  ];
  for (const url of gates) {
    assert.equal(startupPageKind(url), "account");
    let navigated = 0;
    const result = await settleStartupNavigation({
      listTargets: async () => [{ id: "tab", url }],
      navigate: async () => { navigated += 1; },
      pause: async () => { throw new Error("should not wait on an account gate"); },
      attempts: STARTUP_FEED_ATTEMPTS,
    });
    assert.equal(result.kind, "account");
    assert.equal(result.url, url);
    assert.equal(navigated, 0);
  }
  assert.equal(startupPageKind("chrome-error://chromewebdata/"), "proxy-error");
  assert.equal(startupPageKind("https://www.linkedin.com/feed/"), "linkedin");

  let url = "https://mail.google.com/mail/u/0/";
  let navigated = 0;
  const landed = await settleStartupNavigation({
    listTargets: async () => [{ id: "tab", url }],
    navigate: async () => {
      navigated += 1;
      url = "https://www.linkedin.com/checkpoint/challenge/1";
    },
    pause: async () => {},
    attempts: STARTUP_FEED_ATTEMPTS,
  });
  assert.equal(landed.kind, "account");
  assert.equal(navigated, 1);
});

test("local start waits out missing tabs, then stops the browser without an account pause", async () => {
  const waits = [];
  let lists = 0;
  const started = launcher({
    pause: async (ms) => { waits.push(ms); },
    listTargets: async () => { lists += 1; return []; },
    navigateTarget: async () => { throw new Error("must not navigate without a tab"); },
  });
  await assert.rejects(() => started.start("fixture"), (error) => {
    assert.equal(failureKind(error), "infra");
    assert.match(error.message, /no tabs/i);
    assert.match(error.message, /not paused/i);
    assert.notEqual(error.retainBrowserLock, true);
    return true;
  });
  assert.equal(lists, INITIAL_TAB_ATTEMPTS);
  assert.equal(waits.filter((ms) => ms === INITIAL_TAB_WAIT_MS).length, INITIAL_TAB_ATTEMPTS - 1);
  assert.equal(started.profileId, null);
});

test("local start retries a Chrome error page onto the feed and leaves a login tab alone", async () => {
  const navigations = [];
  const stuck = launcher({
    listTargets: async () => [{ id: "tab", url: "chrome-error://chromewebdata/", webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/1" }],
    navigateTarget: async (_target, feed) => { navigations.push(feed); },
  });
  await assert.rejects(() => stuck.start("fixture"), (error) => failureKind(error) === "infra" && /chrome-error/.test(error.message));
  assert.deepEqual(navigations, Array(STARTUP_FEED_ATTEMPTS).fill(STARTUP_FEED_URL));

  let href = "https://mail.google.com/mail/u/0/";
  const opened = [];
  const gmail = launcher({
    listTargets: async () => [{ id: "tab", url: href }],
    navigateTarget: async (_target, feed) => {
      opened.push(feed);
      href = "https://www.linkedin.com/feed/";
    },
  });
  assert.match(await gmail.start("fixture"), /^ws:\/\/127\.0\.0\.1/);
  assert.deepEqual(opened, [STARTUP_FEED_URL]);

  for (const url of ["https://www.linkedin.com/login", "https://www.linkedin.com/checkpoint/challenge/x"]) {
    let navigated = 0;
    const account = launcher({
      pause: async () => { throw new Error("should not wait"); },
      listTargets: async () => [{ id: "tab", url }],
      navigateTarget: async () => { navigated += 1; },
    });
    assert.match(await account.start("fixture"), /^ws:\/\/127\.0\.0\.1/);
    assert.equal(navigated, 0);
  }

  const guard = launcher({});
  await assert.rejects(
    () => guard.navigateFeed({ url: "chrome-error://chromewebdata/", webSocketDebuggerUrl: "ws://attacker.invalid/devtools/page/1" }, STARTUP_FEED_URL),
    /non-local/,
  );
  await guard.navigateFeed({ url: "https://www.linkedin.com/login" }, STARTUP_FEED_URL);
  await assert.rejects(() => guard.navigateFeed({ url: "chrome-error://chromewebdata/" }, "https://evil.example/phish"), /non-feed/);
});
