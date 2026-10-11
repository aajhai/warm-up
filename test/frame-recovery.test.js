import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "warmup-frame-"));
process.env.WARMUP_DATA_DIR = root;
process.env.WARMUP_LOG_DIR = join(root, "logs");
process.env.GL_PROFILE_NAME = "Fixture";
process.env.GL_PROFILE_ID = "fixture-frame";

const { FEED_FRAME_ATTEMPTS, runPlannedSteps } = await import("../src/runner.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

const SHIVRAJ = "Attempted to use detached Frame 'BC2787B4493EFB3E2AAD1B1BDADB5639'.";
const DIPENDRA = "Attempted to use detached Frame '56FD3ABED50E1AD9E71798B4308DEDB4'.";
const quiet = async () => {};
const clearFeed = async () => ({ overlays: [], chromePresent: true, bodyText: "" });

test("detached frame after a productive session does not discard the result", async () => {
  let feedCalls = 0;
  let grownOn = null;
  const browser = { pages: async () => [dead, live] };
  const dead = {
    url: () => "https://www.linkedin.com/feed/",
    evaluate: async () => { throw new Error(SHIVRAJ); },
    browser: () => browser,
  };
  const live = {
    url: () => "https://www.linkedin.com/feed/",
    evaluate: clearFeed,
    browser: () => browser,
  };
  const result = await runPlannedSteps(dead, {}, { order: ["feed", "grow"], inviteCount: 1 }, null, {
    frameWait: quiet,
    steps: {
      feed: async (_page, _plan, _optimizer, { onProgress }) => {
        feedCalls += 1;
        onProgress({ likes: 1, postsSeen: 36, expanded: 13, seeNewPosts: 0 });
        throw new Error(SHIVRAJ);
      },
      grow: async (page) => {
        grownOn = page;
        return { connections: 0, attempted: 0, sent: [] };
      },
    },
  });
  assert.equal(feedCalls, 1);
  assert.equal(grownOn, live);
  assert.equal(result.aborted, false);
  assert.equal(result.checkpoint, false);
  assert.equal(result.accountBlock ?? null, null);
  assert.equal(result.failureKind, undefined);
  assert.equal(result.likes, 1);
  assert.equal(result.postsSeen, 36);
  assert.equal(result.expanded, 13);
});

test("detached frame before the feed re-resolves from the browser, never re-runs on the dead frame, then fails cleanly", async () => {
  let feedCalls = 0;
  let grew = false;
  const browser = { pages: async () => [dead] };
  const dead = {
    // Cached URL still reads /feed/ after the frame is gone. CDP does not.
    url: () => "https://www.linkedin.com/feed/",
    evaluate: async () => { throw new Error(DIPENDRA); },
    browser: () => browser,
  };
  const result = await runPlannedSteps(dead, {}, { order: ["feed", "grow"], inviteCount: 2 }, null, {
    frameWait: quiet,
    steps: {
      feed: async () => {
        feedCalls += 1;
        throw new Error(DIPENDRA);
      },
      grow: async () => {
        grew = true;
        return { connections: 0, attempted: 0, sent: [] };
      },
    },
  });
  assert.equal(feedCalls, 1, "no live page appeared, so the dead frame was not driven again");
  assert.equal(grew, false);
  assert.equal(result.aborted, true);
  assert.equal(result.postsSeen, 0);
  assert.equal(result.likes, 0);
  assert.equal(result.expanded, 0);
  assert.equal(result.checkpoint, false);
  assert.equal(result.accountBlock ?? null, null);
  assert.equal(result.failureKind, "infra");
  assert.match(result.reason, /Feed frame detached before any posts were read after 3 navigation attempts/);
});

test("a detached frame on a challenge page is not recorded as success", async () => {
  let feedCalls = 0;
  let grew = false;
  const browser = { pages: async () => [challenge] };
  const challenge = {
    url: () => "https://www.linkedin.com/checkpoint/challenge/abc",
    evaluate: async () => ({ overlays: ["verify you're a real person"], chromePresent: false, bodyText: "" }),
    browser: () => browser,
  };
  const result = await runPlannedSteps(challenge, {}, { order: ["feed", "grow"], inviteCount: 1 }, null, {
    frameWait: quiet,
    steps: {
      feed: async (_page, _plan, _optimizer, { onProgress }) => {
        feedCalls += 1;
        onProgress({ likes: 1, postsSeen: 36, expanded: 13, seeNewPosts: 0 });
        throw new Error(SHIVRAJ);
      },
      grow: async () => {
        grew = true;
        return { connections: 0, attempted: 0, sent: [] };
      },
    },
  });
  assert.equal(feedCalls, 1);
  assert.equal(grew, false);
  assert.equal(result.aborted, true);
  assert.equal(result.checkpoint, true);
  assert.equal(result.accountBlock.kind, "challenge");
  assert.match(result.reason, /challenge/i);
  assert.equal(result.postsSeen, 36);
});

test("feed navigation retries on a live page after a startup frame drop", async () => {
  const seen = [];
  const browser = { pages: async () => [dead, live] };
  const dead = {
    url: () => "https://www.linkedin.com/mynetwork/grow/",
    evaluate: async () => { throw new Error(DIPENDRA); },
    browser: () => browser,
  };
  const live = {
    url: () => "https://www.linkedin.com/feed/",
    evaluate: clearFeed,
    browser: () => browser,
  };
  const result = await runPlannedSteps(dead, {}, { order: ["feed"] }, null, {
    frameWait: quiet,
    steps: {
      feed: async (page) => {
        seen.push(page);
        if (page === dead) throw new Error(DIPENDRA);
        return { likes: 0, postsSeen: 8, expanded: 1, aborted: false, checkpoint: false, deniedReasons: {} };
      },
    },
  });
  assert.deepEqual(seen, [dead, live]);
  assert.equal(result.aborted, false);
  assert.equal(result.postsSeen, 8);
});

test("a non-frame feed error is not turned into a recovered success", async () => {
  await assert.rejects(
    runPlannedSteps({ browser: () => ({ pages: async () => [] }) }, {}, { order: ["feed"] }, null, {
      frameWait: quiet,
      steps: { feed: async () => { throw new Error("Protocol error: Connection closed."); } },
    }),
    /Connection closed/,
  );
});
