import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { HumanController } from "../human/input.js";
import { createLogger } from "../logger.js";
import { chance, randomInt, sleepJitter } from "../util/random.js";
import { inspectAccount } from "./accountGuard.js";
import { foregroundPage } from "../browser/page.js";
import {
  collectPosts,
  dismissBlockingModals,
  dumpFeedDom,
  findSeeNewPosts,
  inspectFeed,
  mediaOverlayOpen,
  postIsLiked,
  reactionMenuOpen,
} from "./linkedinDom.js";

const log = createLogger("scenario");
const FEED_URL = config.feedUrl;
const BLOCKED_RE = /checkpoint|authwall|login|challenge|uas\/login|captcha/i;
const OFF_FEED_RE = /linkedin\.com\/(in|company|school|jobs|messaging|login|checkpoint|signup|preload)\b/i;

function feedPath(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

function isOnHomeFeed(url) {
  try { return ["linkedin.com", "www.linkedin.com"].includes(new URL(url).hostname) && feedPath(url) === "/feed"; }
  catch { return false; }
}

function deniedTally() {
  return {};
}

async function recoverHomeFeed(page) {
  const url = page.url();
  if (isOnHomeFeed(url) && !OFF_FEED_RE.test(url)) return true;
  log.warn("Left the home feed. Going back once.", { url });
  await screenshot(page, "left-feed");
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 12_000 });
  } catch {
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  }
  await sleepJitter(1200, 2200);
  if (isOnHomeFeed(page.url())) return true;
  log.error("Could not return to /feed/. Aborting so we do not browse a profile.", { url: page.url() });
  return false;
}

function closeUnexpectedTabs(page) {
  page.on("popup", async (popup) => {
    log.warn("Closing unexpected tab.", { url: popup.url() });
    await popup.close().catch(() => {});
  });
}

async function screenshot(page, name) {
  try {
    mkdirSync(join(process.cwd(), "logs"), { recursive: true });
    const path = join(process.cwd(), "logs", `${Date.now()}-${name}.png`);
    await page.screenshot({ path, fullPage: false });
    log.warn("Saved screenshot", { path });
  } catch (error) {
    log.debug("Screenshot failed", { message: error.message });
  }
}

async function detectBlock(page) {
  const block = await inspectAccount(page);
  return block ? { blocked: true, ...block } : { blocked: false };
}

async function writeFeedDump(page, name) {
  try {
    mkdirSync(join(process.cwd(), "logs"), { recursive: true });
    const dump = await dumpFeedDom(page);
    const path = join(process.cwd(), "logs", `${Date.now()}-${name}.json`);
    writeFileSync(path, JSON.stringify(dump, null, 2));
    log.warn("Wrote feed DOM dump", {
      path,
      likeButtons: dump.likeButtons,
      commentButtons: dump.commentButtons,
      cssPosts: dump.cssPosts,
      socialPosts: dump.socialPosts,
      viewNames: (dump.viewNames || []).slice(0, 20),
    });
    return dump;
  } catch (error) {
    log.warn("Feed DOM dump failed", { message: error.message });
    return null;
  }
}

async function homeNavPoint(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a")];
    const home = links.find((a) => {
      const href = a.getAttribute("href") || "";
      let path = "";
      try {
        path = new URL(href, location.origin).pathname.replace(/\/+$/, "") || "/";
      } catch {
        return false;
      }
      if (path !== "/feed") return false;
      const label = `${a.getAttribute("aria-label") || ""} ${a.innerText || ""}`.toLowerCase();
      return /\bhome\b/.test(label) || Boolean(a.closest("header, nav"));
    });
    if (!home) return null;
    const r = home.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
}

async function openFeed(page, human) {
  const url = page.url();
  log.info("Current tab", { url });
  if (BLOCKED_RE.test(url)) return { checkpoint: true };
  if (isOnHomeFeed(url)) {
    await sleepJitter(1800, 4200);
    return { checkpoint: false };
  }
  if (/linkedin\.com/i.test(url) && !BLOCKED_RE.test(url)) {
    const home = await homeNavPoint(page);
    if (home) {
      log.info("Not on home feed. Clicking Home in the nav.", { from: url });
      const clicked = await human.clickAt(home.x, home.y, "home");
      await sleepJitter(2500, 5200);
      if (clicked && isOnHomeFeed(page.url())) return { checkpoint: false };
    }
  }
  log.info("Opening the home feed URL.", { from: page.url() });
  await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleepJitter(2800, 6200);
  return { checkpoint: false };
}

async function maybeGlanceNotifications(page, human) {
  try {
    const bell = await page.$("button[aria-label*='Notifications'], a[href*='/notifications/']");
    if (!bell) return;
    const box = await bell.boundingBox();
    if (!box) return;
    await human.moveTo(box.x + box.width / 2, box.y + box.height / 2);
    await sleepJitter(700, 1600);
    await human.ensureOverFeed();
  } catch (error) {
    log.debug("Notification glance skipped", { message: error.message });
  }
}

async function dismissReactionMenu(page) {
  if (await reactionMenuOpen(page)) {
    await page.keyboard.press("Escape");
    await sleepJitter(250, 700);
  }
}

async function dismissMediaOverlay(page) {
  if (await mediaOverlayOpen(page)) {
    await page.keyboard.press("Escape");
    await sleepJitter(200, 500);
    return true;
  }
  return false;
}

async function clickFresh(page, human, urn, kind) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const point = await human.revealControl(urn, kind);
    if (!point) return null;
    if (await human.clickAt(point.x, point.y, kind, urn)) return point;
  }
  return null;
}

async function maybeSeeNewPosts(page, human, stats, { force = false } = {}) {
  const pill = await findSeeNewPosts(page);
  if (!pill) return false;
  if (!force && stats.postsSeen < 3) return false;
  if (!force && !stats.stuck && !chance(0.72)) return false;
  log.info("Feed stalled or new content pill visible. Clicking See new posts.", { label: pill.label, force, stuck: stats.stuck });
  const clicked = await human.clickAt(pill.x, pill.y, "see-new");
  if (!clicked) return false;
  await sleepJitter(1800, 3600);
  stats.stuck = 0;
  stats.seeNewPosts += 1;
  human.postsCacheAt = 0;
  await human.ensureOverFeed();
  return true;
}

async function refreshStaleFeed(page, human, stats) {
  const before = await human.scrollOffset();
  const atBottom = before.top >= before.maxTop - 8 || before.top > 8000;
  if (!atBottom && stats.stuck < 2) return false;
  const clicked = await maybeSeeNewPosts(page, human, stats, { force: true });
  await sleepJitter(700, 1400);
  human.postsCacheAt = 0;
  let after = await human.scrollOffset();
  if (clicked && (after.top < before.top - 80 || after.top < 600)) {
    log.info("See new posts moved the feed off the bottom.", { from: before.top, to: after.top });
    return true;
  }
  // Prefer a soft jump to the top over hard reloads — short/new-account feeds often
  // have no "See new posts" pill, and repeated goto() hangs Orbita CDP.
  stats.feedReloads = stats.feedReloads || 0;
  if (stats.feedReloads >= 1) {
    log.warn("Skipping another /feed/ reload; reversing instead.", { top: after.top, maxTop: after.maxTop, clicked });
    try {
      await page.evaluate(() => {
        const main = document.querySelector("main") || document.scrollingElement || document.documentElement;
        if (main && "scrollTo" in main) main.scrollTo({ top: 0, behavior: "instant" in document.documentElement.style ? "instant" : "auto" });
        else window.scrollTo(0, 0);
      });
    } catch (error) {
      log.warn("Soft feed jump failed.", { message: error.message });
    }
    await sleepJitter(800, 1600);
    human.postsCacheAt = 0;
    after = await human.scrollOffset();
    const jumped = after.top < before.top - 80 || after.top < 800;
    if (jumped || after.top < 200) stats.stuck = 0;
    return jumped || after.top < 200;
  }
  log.warn("See new posts did not jump the feed. Reloading /feed/.", { top: after.top, maxTop: after.maxTop, clicked });
  stats.feedReloads += 1;
  try {
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    log.warn("Feed reload timed out.", { message: error.message });
  }
  await sleepJitter(2200, 4200);
  human.postsCacheAt = 0;
  after = await human.scrollOffset();
  const moved = after.top < before.top - 80 || after.top < 800;
  log.info("Home feed reload result.", { from: before.top, to: after.top, moved });
  if (moved) stats.stuck = 0;
  return moved;
}

async function waitForPosts(page, human) {
  await foregroundPage(page).catch(() => {});
  const deadline = Date.now() + 25_000;
  let onboardingScrolls = 0;
  while (Date.now() < deadline) {
    try {
      await dismissBlockingModals(page);
      await dismissMediaOverlay(page);
      await page.keyboard.press("Escape").catch(() => {});
    } catch (error) {
      log.debug("Modal dismiss skipped", { message: error.message });
    }
    const snapshot = await inspectFeed(page);
    log.info("Feed inspect.", snapshot);
    let posts = await collectPosts(page);
    if (posts.length > 0) return posts;

    // Cards exist in the DOM but sit outside the readable band (common when
    // People You May Know fills the viewport and the first real post is below).
    if (snapshot.socialPosts > 0 || snapshot.likeButtons > 0) {
      posts = await collectPosts(page, { reveal: true });
      if (posts.length > 0) {
        log.info("Brought a feed update into view.", { count: posts.length });
        return posts;
      }
      if (onboardingScrolls < 5) {
        onboardingScrolls += 1;
        try {
          await human.scrollFeed({ reverseChance: 0 });
        } catch (error) {
          // A timed-out wheel may still reach Orbita. Re-inspect rather than letting
          // a recoverable input stall fail the entire session.
          log.warn("Onboarding scroll failed; re-checking the feed.", { message: error.message });
        }
        await sleepJitter(500, 1000);
        continue;
      }
    }
    await human.driftTo(
      (human.x || 480) + randomInt(-20, 20),
      (human.y || 280) + randomInt(-24, 24),
    );
    await sleepJitter(800, 1400);
  }
  await writeFeedDump(page, "feed-dom");
  await screenshot(page, "empty-feed");
  return [];
}

async function expandPost(page, human, post) {
  const point = await clickFresh(page, human, post.urn, "more");
  if (!point) return false;
  log.info("Expanded post via More.", { urn: post.urn });
  await human.waitAfterExpand();
  return true;
}

async function likePost(page, human, post) {
  await dismissReactionMenu(page);
  await dismissMediaOverlay(page);
  const point = await clickFresh(page, human, post.urn, "like");
  if (!point) return false;
  await sleepJitter(350, 900);
  if (await dismissMediaOverlay(page)) {
    log.warn("Like click opened media. Closing overlay.", { urn: post.urn });
    return false;
  }
  if (await reactionMenuOpen(page)) {
    log.info("Reaction picker opened. Closing it and retaining the attempt budget.");
    await page.keyboard.press("Escape");
    await sleepJitter(300, 700);
    // A reaction is a toggle; do not retry an unverified click.
    return false;
  }
  const liked = await postIsLiked(page, post.urn);
  if (!liked) log.warn("Like click did not stick.", { urn: post.urn, label: point.label });
  return liked;
}

export async function runLinkedInFeed(page, plan, optimizer, { signal } = {}) {
  closeUnexpectedTabs(page);
  const human = new HumanController(page);
  const started = Date.now();
  const endsAt = started + plan.sessionMs;
  const stats = {
    likes: 0,
    likeAttempts: 0,
    postsSeen: 0,
    expanded: 0,
    lastLikeAt: 0,
    stuck: 0,
    seeNewPosts: 0,
  };
  const seen = new Set();
  const handled = new Set();
  const deniedReasons = deniedTally();
  const result = {
    likes: 0,
    postsSeen: 0,
    expanded: 0,
    seeNewPosts: 0,
    durationMs: 0,
    aborted: false,
    checkpoint: false,
    deniedReasons,
  };

  const opened = await openFeed(page, human);
  let block = { blocked: false };
  try {
    block = await detectBlock(page);
  } catch (error) {
    log.warn("Initial account inspect timed out; continuing if the feed looks reachable.", { message: error.message });
  }
  if (block.blocked) {
    log.error("LinkedIn is challenging this session. Aborting.", { reason: block.reason });
    await screenshot(page, "checkpoint");
    result.aborted = true;
    result.checkpoint = true;
    result.accountBlock = block;
    result.reason = block.reason;
    result.durationMs = Date.now() - started;
    return result;
  }

  await page.waitForSelector("main, [data-testid='mainFeed'], div.scaffold-layout, body", { timeout: 25_000 }).catch(() => {});
  log.info("Feed tab ready.", { url: page.url() });
  const readyPosts = await waitForPosts(page, human);
  if (readyPosts.length === 0) {
    log.error("LinkedIn /feed/ rendered with zero posts. Not scrolling a blank page.");
    result.aborted = true;
    result.reason = "Feed rendered without readable posts";
    result.durationMs = Date.now() - started;
    return result;
  }
  for (const post of readyPosts) {
    if (!seen.has(post.urn)) {
      seen.add(post.urn);
      stats.postsSeen += 1;
    }
  }
  await writeFeedDump(page, "feed-dom-found");
  log.info("Posts are in the DOM. Starting human scroll with pointer tracking.", { count: readyPosts.length, postsSeen: stats.postsSeen });
  try {
    const startPos = await human.scrollOffset();
    if (startPos.top >= startPos.maxTop - 8 || startPos.top > 8000) {
      log.warn("Feed opened already at the bottom. Jumping to fresh content.", startPos);
      await refreshStaleFeed(page, human, stats);
    } else {
      const firstScroll = await human.scrollFeed({ reverseChance: 0 });
      log.info("Initial feed scroll.", firstScroll);
    }
  } catch (error) {
    log.warn("Initial scroll failed. Continuing if the page is still alive.", { message: error.message });
  }

  if (plan.glanceNotifications) {
    log.info("Glancing at notifications without opening them.");
    await maybeGlanceNotifications(page, human);
  }

  log.info("Browsing LinkedIn home feed.", {
    sessionMin: Math.round(plan.sessionMs / 6000) / 10,
    likeCap: plan.likeCap,
    likeRate: Number(plan.likeRate.toFixed(3)),
    expandRate: Number(plan.expandRate.toFixed(3)),
    reverseScrollChance: plan.reverseScrollChance,
  });

  let lastSeenCount = 0;

  while (Date.now() < endsAt) {
    signal?.throwIfAborted();
    const remainingMs = endsAt - Date.now();
    const elapsedMs = Date.now() - started;
    let liveBlock;
    try {
      liveBlock = await detectBlock(page);
    } catch (error) {
      log.warn("Account inspect timed out; ending browse with posts already seen.", { message: error.message, postsSeen: stats.postsSeen });
      result.reason = error.message;
      if (!(plan.testRun && stats.postsSeen > 0)) result.aborted = true;
      break;
    }
    if (liveBlock.blocked) {
      log.error("Checkpoint appeared mid-session. Stopping.", { reason: liveBlock.reason });
      await screenshot(page, "checkpoint-mid");
      result.aborted = true;
      result.checkpoint = true;
      result.accountBlock = liveBlock;
      result.reason = liveBlock.reason;
      break;
    }
    if (!(await recoverHomeFeed(page))) {
      result.aborted = true;
      break;
    }

    if (stats.stuck >= 2) {
      const refreshed = await refreshStaleFeed(page, human, stats);
      if (!refreshed) {
        try {
          await human.scrollFeed({ forceReverse: true });
        } catch (error) {
          log.warn("Unstick scroll failed, continuing browse.", { message: error.message });
        }
      }
    } else {
      await maybeSeeNewPosts(page, human, stats);
    }

    let posts = [];
    try {
      posts = await collectPosts(page);
      if (!posts.length) {
        // After onboarding/scroll, updates can sit just outside the readable band.
        posts = await collectPosts(page, { reveal: true });
      }
    } catch (error) {
      log.warn("Post collect timed out; ending browse with posts already seen.", { message: error.message, postsSeen: stats.postsSeen });
      result.reason = error.message;
      if (!(plan.testRun && stats.postsSeen > 0)) result.aborted = true;
      break;
    }
    for (const post of posts) {
      if (!seen.has(post.urn)) {
        seen.add(post.urn);
        stats.postsSeen += 1;
      }
    }

    if (stats.postsSeen === lastSeenCount) stats.stuck += 1;
    else stats.stuck = 0;
    lastSeenCount = stats.postsSeen;
    if (stats.stuck >= 8) {
      if (await refreshStaleFeed(page, human, stats)) continue;
      try {
        const backed = await human.scrollFeed({ forceReverse: true });
        if (backed.moved !== null && Math.abs(backed.moved) >= 8) {
          stats.stuck = 0;
          continue;
        }
      } catch (error) {
        log.warn("Could not reverse away from the bottom of the feed.", { message: error.message });
      }
      result.aborted = true;
      result.reason = "Feed did not advance after repeated scroll attempts";
      break;
    }

    const focus = posts.find((post) => (
      !handled.has(post.urn)
      && post.top > 70
      && post.top < 560
    ));

    if (focus) {
      handled.add(focus.urn);
      await human.moveTo(focus.midX + randomInt(-24, 24), Math.max(100, focus.midY));
      await human.readPause(Math.min(focus.textLen, 280));

      let didExpand = false;
      if (focus.hasMore) {
        const expand = optimizer.gateExpand({ post: focus, stats });
        if (expand.allow) {
          try {
            didExpand = await expandPost(page, human, focus);
            if (didExpand) stats.expanded += 1;
          } catch (error) {
            log.warn("More expand failed, continuing browse.", { message: error.message });
          }
          if (!(await recoverHomeFeed(page))) {
            result.aborted = true;
            break;
          }
        } else {
          deniedReasons[expand.reason] = (deniedReasons[expand.reason] || 0) + 1;
        }
      }

      const fresh = (await collectPosts(page)).find((post) => post.urn === focus.urn) || focus;
      fresh.didExpand = didExpand;

      const gate = optimizer.gateLike({
        post: fresh,
        stats,
        elapsedMs: Date.now() - started,
        remainingMs: endsAt - Date.now(),
      });
      if (!gate.allow) {
        deniedReasons[gate.reason] = (deniedReasons[gate.reason] || 0) + 1;
      } else {
        const actionId = optimizer.reserveLike(fresh);
        if (!actionId) continue;
        stats.likeAttempts += 1;
        let liked = false;
        try {
          signal?.throwIfAborted();
          liked = await likePost(page, human, fresh);
          if (liked) {
            stats.likes += 1;
            stats.lastLikeAt = Date.now();
            log.info("Liked a post.", { urn: fresh.urn, likes: stats.likes, expanded: didExpand });
            await sleepJitter(700, 1600);
          }
        } catch (error) {
          log.error("Like click failed; its budget reservation is retained.", { message: error.message });
        }
        optimizer.finishLike(actionId, liked);
      }
    }

    if (chance(plan.idleChance)) await human.idle();
    try {
      const scrolled = await human.scrollFeed({ reverseChance: plan.reverseScrollChance });
      const atBottom = Number.isFinite(scrolled?.after?.top) && Number.isFinite(scrolled?.after?.maxTop)
        && scrolled.after.top >= scrolled.after.maxTop - 8;
      if (scrolled.moved !== null && scrolled.moved < 8) {
        log.warn("Scroll did not move the feed.", scrolled);
        if (await refreshStaleFeed(page, human, stats)) continue;
        if (atBottom) {
          const backed = await human.scrollFeed({ forceReverse: true });
          if (backed.moved !== null && Math.abs(backed.moved) < 8) {
            log.warn("Reverse scroll also failed at the bottom of the feed.", backed);
          }
        }
      }
    } catch (error) {
      log.warn("Scroll gesture failed, continuing browse.", { message: error.message });
    }
  }

  if (!result.aborted) {
    log.info("Wind-down. No more likes. Leaving the feed as a person would.");
    try {
      await human.scrollFeed({ reverseChance: 0.03 });
      await sleepJitter(1200, 2800);
      await human.idle();
    } catch (error) {
      log.warn("Wind-down gesture failed.", { message: error.message });
    }
  }

  result.likes = stats.likes;
  result.postsSeen = stats.postsSeen;
  result.expanded = stats.expanded;
  result.seeNewPosts = stats.seeNewPosts;
  result.durationMs = Date.now() - started;
  // New/short feeds (esp. cloud/local test profiles) may only expose a handful of
  // updates. Browse-only test runs only need proof the collector found real posts.
  if (!result.aborted && result.postsSeen < 5) {
    if (plan.testRun && result.postsSeen > 0) {
      log.info("Browse-only test saw a short feed; accepting postsSeen below production bar.", { postsSeen: result.postsSeen });
    } else {
      result.aborted = true;
      result.reason = "Too few distinct posts to verify useful feed browsing";
    }
  }
  return result;
}

export async function getWorkingPage(browser) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const pages = await browser.pages();
      const feed = pages.find((page) => {
        try { return isOnHomeFeed(page.url()); } catch { return false; }
      });
      const linkedin = pages.find((page) => {
        try { return ["www.linkedin.com", "linkedin.com"].includes(new URL(page.url()).hostname); }
        catch { return false; }
      });
      const page = feed || linkedin || pages[0];
      if (!page) throw new Error("Profile opened with no tabs. Refusing to create a new page.");
      // Orbita can restore a hidden tab; native input can stall until it is foregrounded.
      await foregroundPage(page, { timeoutMs: 6_000 });
      // Touch the target once so a half-attached Orbita tab fails here, not mid-scenario.
      const href = await Promise.race([
        Promise.resolve().then(() => page.url()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("page.url timed out")), 5_000)),
      ]);
      if (!href) throw new Error("Working tab has no URL yet.");
      return page;
    } catch (error) {
      lastError = error;
      log.warn("Working tab not ready yet.", { attempt, message: error.message });
      await sleepJitter(1200, 2200);
    }
  }
  throw lastError || new Error("Profile opened with no usable tabs.");
}
