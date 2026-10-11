import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { HumanController } from "../human/input.js";
import { createLogger } from "../logger.js";
import { chance, randomInt, sleepJitter } from "../util/random.js";
import { accountBlockFromUrl, inspectAccount, observedAccountBlock } from "./accountGuard.js";
import { browserOf, foregroundPage, isDetachedFrameError, markRestoredTabs, readPageUrl, waitForLiveLinkedInPage } from "../browser/page.js";
import { infrastructureError, isInfrastructureFailure } from "../util/failures.js";
import { returnFrom } from "./linkedinProfile.js";
import {
  collectPosts,
  dialogOpen,
  dismissBlockingModals,
  dumpFeedDom,
  findFollowCandidates,
  findSeeNewPosts,
  scanThinFeedFollowPlan,
  readThinFollowStatus,
  followState,
  locateFollow,
  healFeedColumn,
  inspectFeed,
  locateControl,
  readFeedColumn,
  readFeedLoadSnapshot,
  mediaOverlayOpen,
  postIsLiked,
  reactionMenuOpen,
} from "./linkedinDom.js";

const log = createLogger("scenario");
const FEED_URL = config.feedUrl;
const BLOCKED_RE = /checkpoint|authwall|login|challenge|uas\/login|captcha/i;
const OFF_FEED_RE = /linkedin\.com\/(in|company|school|jobs|messaging|login|checkpoint|signup|preload)\b/i;

function rethrowInfrastructure(error) {
  if (isInfrastructureFailure(error)) throw error;
}

function feedPath(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

function isGmailOrBing(href) {
  let host = "";
  try { host = new URL(href).hostname.toLowerCase(); } catch { return false; }
  return host === "mail.google.com" || host === "gmail.com" || host === "bing.com" || host.endsWith(".bing.com");
}

function isOnHomeFeed(url) {
  try { return ["linkedin.com", "www.linkedin.com"].includes(new URL(url).hostname) && feedPath(url) === "/feed"; }
  catch { return false; }
}

function deniedTally() {
  return {};
}

function safePageUrl(page) {
  try { return page.url(); } catch { return ""; }
}

export function isChromeErrorUrl(url) {
  return /^chrome-error:/i.test(String(url || ""));
}

export function isNullFeedRootError(error) {
  return /cannot read properties of null \(reading 'queryselectorall'\)/i.test(error?.message || "");
}

const CHROME_ERROR_ATTEMPTS = 3;
const CONNECTION_LOAD_ATTEMPTS = 3;

export function isConnectionDrop(error) {
  return /net::ERR_CONNECTION_(CLOSED|RESET|ABORTED)|net::ERR_NETWORK_CHANGED|net::ERR_INTERNET_DISCONNECTED/i.test(error?.message || "");
}

// A detached frame is a dead CDP target, not a failed account check. A still-live
// LinkedIn tab should continue the planned browse. No live tab is infrastructure.
export function detachedInspectAction(error, livePage) {
  if (!isDetachedFrameError(error)) return null;
  return livePage ? { action: "continue" } : { action: "infra" };
}

// A dropped reload is not an empty feed. Zero posts still fail the bar.
// Posts already seen, plus a connection drop, must not.
export function shouldAbortFewPosts({ aborted = false, postsSeen = 0, testRun = false, connectionClosed = false } = {}) {
  if (aborted || postsSeen >= 5) return false;
  if (testRun && postsSeen > 0) return false;
  if (connectionClosed && postsSeen > 0) return false;
  return true;
}

// A login wall, authwall, or checkpoint is an account state. Stop navigating and
// let the existing account check pause the profile.
export function isAccountWallUrl(url) {
  const value = String(url || "");
  if (!value || isChromeErrorUrl(value)) return false;
  try {
    const path = new URL(value).pathname;
    return /\/checkpoint(?:\/|$)|\/challenge(?:\/|$)|\/uas\/login(?:\/|$)|\/login(?:\/|$)|\/authwall(?:\/|$)/i.test(path)
      || /authwall/i.test(path);
  } catch {
    return /authwall|\/checkpoint|\/challenge|\/uas\/login|\/login/i.test(value);
  }
}

// chrome-error is a failed document, not a feed. Never page.reload() it: that
// stays on chrome-error. Load the real feed URL, at most three times.
export async function recoverChromeError(page, { pause = sleepJitter } = {}) {
  const start = safePageUrl(page);
  log.warn("Browser error page is not a feed. Loading the feed URL without reloading it.", { url: start });
  let lastUrl = start;
  for (let attempt = 1; attempt <= CHROME_ERROR_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await pause(8_000, 10_000);
    try {
      await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      log.warn("Feed URL load failed.", { attempt, message: error.message });
    }
    lastUrl = safePageUrl(page);
    if (isAccountWallUrl(lastUrl)) {
      log.warn("Feed URL load hit an account wall. Stopping retries so the account check can pause.", { url: lastUrl, attempt });
      return { ok: false, accountWall: true, url: lastUrl };
    }
    if (!isChromeErrorUrl(lastUrl) && isOnHomeFeed(lastUrl)) {
      log.info("Feed URL load settled.", { url: lastUrl, attempt });
      return { ok: true, accountWall: false, url: lastUrl };
    }
    if (isChromeErrorUrl(lastUrl)) {
      log.warn("Feed URL load landed on a browser error page. Not reloading it.", { url: lastUrl, attempt });
    } else {
      log.warn("Feed URL load did not reach the home feed.", { url: lastUrl, attempt });
    }
  }
  if (isChromeErrorUrl(lastUrl)) {
    throw infrastructureError(`Feed stayed on chrome-error after ${CHROME_ERROR_ATTEMPTS} loads of ${FEED_URL}. Last URL: ${lastUrl}`);
  }
  return { ok: false, accountWall: false, url: lastUrl };
}

// One cache-bypass reload of a real feed document. page.goto of the same URL
// is not a hard refresh. A chrome-error document is never reloaded.
export async function hardRefreshFeed(page, stats, { pause = sleepJitter } = {}) {
  const url = safePageUrl(page);
  if (isChromeErrorUrl(url)) return false;
  if ((stats.feedUrlLoads || 0) >= 1) return false;
  if (typeof page.reload !== "function" && !page.keyboard?.down) return false;
  stats.feedUrlLoads = (stats.feedUrlLoads || 0) + 1;
  log.info("Hard refreshing the LinkedIn feed.", { url, postsSeen: stats.postsSeen || 0, ignoreCache: true });
  if (typeof page.reload === "function") {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000, ignoreCache: true });
  } else {
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyR");
    await page.keyboard.up("Shift");
    await page.keyboard.up(modifier);
    log.info("Hard refresh sent as a cache-bypass keyboard reload.", { modifier });
  }
  await pause(1200, 2600);
  const after = safePageUrl(page);
  if (isAccountWallUrl(after)) return false;
  if (isChromeErrorUrl(after)) {
    log.warn("Hard refresh landed on a browser error page. Not reloading it.", { url: after, postsSeen: stats.postsSeen || 0 });
    const recovered = await recoverChromeError(page, { pause });
    return Boolean(recovered.ok);
  }
  log.info("Hard refresh settled.", { url: after, postsSeen: stats.postsSeen || 0 });
  return isOnHomeFeed(after);
}

// One navigation to the real feed URL per session. Never page.reload, and never
// reload whatever document is current — a chrome-error page is not a feed.
export async function loadRealFeed(page, stats, { pause = sleepJitter } = {}) {
  const url = safePageUrl(page);
  if (isChromeErrorUrl(url)) {
    const recovered = await recoverChromeError(page, { pause });
    return Boolean(recovered.ok);
  }
  if ((stats.feedUrlLoads || 0) >= 1) return false;
  if (typeof page.goto !== "function") return false;
  stats.feedUrlLoads = (stats.feedUrlLoads || 0) + 1;
  log.info("Loading the LinkedIn feed URL.", { from: url, postsSeen: stats.postsSeen || 0 });
  let navigated = false;
  for (let attempt = 1; attempt <= CONNECTION_LOAD_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      navigated = true;
      break;
    } catch (error) {
      const failed = safePageUrl(page);
      if (isAccountWallUrl(failed)) return false;
      if (isChromeErrorUrl(failed)) {
        const recovered = await recoverChromeError(page, { pause });
        return Boolean(recovered.ok);
      }
      if (isConnectionDrop(error) && attempt < CONNECTION_LOAD_ATTEMPTS) {
        log.warn("Feed URL load dropped the connection. Retrying without reloading.", { attempt, message: error.message });
        await pause(8_000, 10_000);
        continue;
      }
      if (isConnectionDrop(error)) {
        stats.connectionClosed = true;
        log.warn("Feed URL load dropped the connection. Not reloading the document.", { attempt, message: error.message, postsSeen: stats.postsSeen || 0 });
        return false;
      }
      throw error;
    }
  }
  if (!navigated) return false;
  await pause(1200, 2600);
  const after = safePageUrl(page);
  if (isAccountWallUrl(after)) return false;
  if (isChromeErrorUrl(after)) {
    log.warn("Feed URL load landed on a browser error page. Not reloading it.", { url: after, postsSeen: stats.postsSeen || 0 });
    const recovered = await recoverChromeError(page, { pause });
    return Boolean(recovered.ok);
  }
  log.info("Feed URL load settled.", { url: after, postsSeen: stats.postsSeen || 0 });
  return isOnHomeFeed(after);
}

export async function recoverHomeFeed(page, stats = {}, { pause = sleepJitter } = {}) {
  const url = safePageUrl(page);
  if (isOnHomeFeed(url) && !OFF_FEED_RE.test(url)) return true;
  log.warn("Left the home feed. Returning through the Home nav.", { url });
  await screenshot(page, "left-feed");
  // Browser Back is never used. A chrome-error page is not reloaded: reloading it
  // stays on chrome-error. Retry the real feed URL instead. /mynetwork comes back
  // through Home, then that same feed URL if the click does not land.
  if (isChromeErrorUrl(url)) {
    const recovered = await recoverChromeError(page, { pause });
    return Boolean(recovered.ok);
  }
  const home = await homeNavPoint(page).catch(() => null);
  if (home) {
    try { await page.mouse.click(home.x, home.y, { delay: 80 }); }
    catch (error) { if (!/detached Frame|Execution context|navigation/i.test(error.message)) throw error; }
    await sleepJitter(1500, 2500);
    if (isOnHomeFeed(page.url())) return true;
    if (isAccountWallUrl(safePageUrl(page))) return false;
    if (isChromeErrorUrl(safePageUrl(page))) {
      const recovered = await recoverChromeError(page, { pause });
      return Boolean(recovered.ok);
    }
  }
  if (typeof page.goto === "function") {
    const loaded = await loadRealFeed(page, stats, { pause }).catch((error) => {
      if (isInfrastructureFailure(error)) throw error;
      log.warn("Feed load failed.", { message: error.message });
      return false;
    });
    if (loaded) return true;
  }
  if (isChromeErrorUrl(safePageUrl(page))) {
    throw infrastructureError(`Feed stayed on chrome-error after loads of ${FEED_URL}. Last URL: ${safePageUrl(page)}`);
  }
  log.error("Could not return to /feed/. Ending the feed step so we do not browse another page.", { url: safePageUrl(page) });
  return false;
}

// False from recoverHomeFeed used to end the feed and let Grow run. An account
// wall must pause instead. A chrome-error page never reaches this: it throws.
export async function requireHomeFeed(page, stats, result) {
  const home = await recoverHomeFeed(page, stats);
  if (home) return "home";
  let block = { blocked: false };
  try {
    block = await detectBlock(page);
  } catch (error) {
    if (isInfrastructureFailure(error)) throw error;
  }
  if (block.blocked) {
    log.error("Checkpoint appeared mid-session. Stopping.", { reason: block.reason });
    await screenshot(page, "checkpoint-mid");
    result.aborted = true;
    result.checkpoint = ["challenge", "restriction", "login"].includes(block.kind);
    result.accountBlock = block;
    result.reason = block.reason;
    return "blocked";
  }
  return "left";
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

const isProtocolTimeout = (error) => /Runtime\.callFunctionOn timed out|protocolTimeout/i.test(error?.message || "");

// One slow evaluate on a slow proxy is retried once before it counts as infrastructure. A wall
// visible in the browser's URLs is reported even when the page cannot be evaluated.
export async function detectBlock(page, { inspect = inspectAccount } = {}) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const block = await inspect(page);
      return block ? { blocked: true, ...block } : { blocked: false };
    } catch (error) {
      if (!isProtocolTimeout(error)) throw error;
      const wall = await observedAccountBlock(browserOf(page), page);
      if (wall) return { blocked: true, ...wall };
      if (attempt === 2) throw error;
      log.warn("Account inspect timed out on a slow page. Retrying it once.", { message: error.message });
    }
  }
  return { blocked: false };
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
  const point = await homeNavLocate(page);
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

async function homeNavLocate(page) {
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
      if (/\bhome\b/.test(label) || a.closest("header, nav")) return true;
      // The redesigned top bar uses plain divs and an icon-only Home link.
      const r = a.getBoundingClientRect();
      return r.width >= 8 && r.height >= 8 && r.top >= 0 && r.bottom <= 90;
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
  // A login wall or the logged-out /hp home is an account state. Never navigate away from it.
  const wall = accountBlockFromUrl(url);
  if (wall) return { checkpoint: true, block: wall };
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

// One locate and one single-press click. A refused hit check or a timed-out press is not
// followed by another locate or press.
async function clickFresh(page, human, urn, kind, { shortPress = false } = {}) {
  const point = await human.revealControl(urn, kind);
  if (!point) return { ok: false, why: "locate-miss", point: null };
  if (await human.clickAt(point.x, point.y, kind, urn, { shortPress, singlePress: true })) {
    return { ok: true, why: null, point };
  }
  return { ok: false, why: "refused-click", point: null };
}

export async function maybeSeeNewPosts(page, human, stats) {
  // A visible pill that never grows the feed (or never matches the click probe)
  // must not burn the whole session in 8s wait loops on the same control.
  if ((stats.seeNewMisses || 0) >= 2) return false;
  const pill = await findSeeNewPosts(page);
  if (!pill) return false;
  const before = await readFeedColumn(page);
  // Scrolling does not mount the next posts. Click the pill when it is on screen,
  // including the collapsed column that shows only the composer and this button.
  log.info("See new posts is on screen. Clicking it so the next posts can load.", { label: pill.label });
  const clicked = await human.clickAt(pill.x, pill.y, "see-new");
  if (!clicked) {
    stats.seeNewMisses = (stats.seeNewMisses || 0) + 1;
    stats.stuck += 1;
    log.info("See new posts click did not land; will not keep retrying the same pill.", {
      label: pill.label,
      seeNewMisses: stats.seeNewMisses,
    });
    return false;
  }
  human.postsCacheAt = 0;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await sleepJitter(500, 900);
    human.postsCacheAt = 0;
    const after = await readFeedColumn(page);
    if ((after?.feedHeight || 0) > (before.feedHeight || 0) + 120 || (after?.visibleUpdates || 0) > before.visibleUpdates) {
      stats.seeNewPosts += 1;
      stats.seeNewMisses = 0;
      stats.stuck = 0;
      log.info("See new posts loaded more of the feed.", { feedHeight: after?.feedHeight, visibleUpdates: after?.visibleUpdates });
      return true;
    }
  }
  stats.seeNewMisses = (stats.seeNewMisses || 0) + 1;
  stats.stuck += 1;
  log.info("Clicked See new posts but the feed column did not grow.", {
    feedHeight: before.feedHeight,
    visibleUpdates: before.visibleUpdates,
    seeNewMisses: stats.seeNewMisses,
  });
  return false;
}

export async function refreshStaleFeed(page, human, stats) {
  const before = await human.scrollOffset();
  const atBottom = before.top >= before.maxTop - 8 || before.top > 8000;
  if (!atBottom && stats.stuck < 2) return false;
  return maybeSeeNewPosts(page, human, stats);
}

const SHORT_COLUMN_MAX = 750;
const COLLAPSED_MAX = 80;

export function columnNeedsRevival({ postsSeen = 0, maxTop, firstTop, visibleUpdates = 0, url, collectorEmpty = false } = {}) {
  if (isChromeErrorUrl(url)) return "chrome-error";
  const collapsed = Number.isFinite(maxTop) && maxTop <= COLLAPSED_MAX;
  // firstTop is a viewport coordinate. maxTop is how far the column can scroll.
  // A post at y=864 on a column that can still scroll 622px is on a short feed,
  // not stranded. Stranded means the scroller cannot travel far enough to reach it.
  const stranded = Number.isFinite(maxTop) && Number.isFinite(firstTop) && maxTop <= 200 && firstTop > maxTop + 160;
  if (collapsed) return "collapsed";
  if (stranded) return "stranded";
  if (postsSeen < 5 && Number.isFinite(maxTop) && maxTop < SHORT_COLUMN_MAX) return "short";
  if (collectorEmpty && visibleUpdates > 0) return "updates-present";
  return null;
}

const HOLD_GROWTH_PX = 40;
const HOLD_RAIL_TEXT = 80;
const HOLD_RAIL_CONTROLS = 3;
const HOLD_SHORT_FEED_PX = 900;
export const FEED_LOADING_PASS_LIMIT = 4;

function paintSignals(snapshot) {
  const feedHeight = Number(snapshot?.feedHeight);
  const railText = Number(snapshot?.railText);
  const railControls = Number(snapshot?.railControls);
  const railsEmpty = (Number.isFinite(railText) ? railText : 0) < HOLD_RAIL_TEXT
    && (Number.isFinite(railControls) ? railControls : 0) < HOLD_RAIL_CONTROLS;
  const mediaPending = (Number(snapshot?.pendingImages) || 0) > 0 || (Number(snapshot?.skeletons) || 0) > 0;
  const feedTall = Number.isFinite(feedHeight) && feedHeight >= HOLD_SHORT_FEED_PX;
  return { feedHeight, railsEmpty, mediaPending, feedTall };
}

// A tall feed column with populated rails is painted, whatever readyState says.
export function feedLooksPainted(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const { railsEmpty, feedTall } = paintSignals(snapshot);
  return feedTall && !railsEmpty;
}

// Pure: no browser. The first matching reason wins. A missing snapshot does not hold.
// LinkedIn's SPA can leave readyState at "interactive" or "loading" indefinitely (long-lived
// requests), so readyState only holds when the page also looks unpainted. On a painted page,
// pending media holds for one wait at most: the next sample of a still-painted page scrolls.
export function scrollHoldReason(snapshot, previousSnapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const { feedHeight, railsEmpty, mediaPending, feedTall } = paintSignals(snapshot);
  const painted = feedTall && !railsEmpty;
  const settledBefore = Boolean(previousSnapshot) && feedLooksPainted(previousSnapshot);
  // After a feed URL load the document can stay "loading" (like "interactive") while the page
  // is fully painted, so readyState alone never holds a painted page.
  if ((snapshot.readyState === "loading" || snapshot.readyState === "interactive") && !painted) return "document";
  if (!(painted && settledBefore)) {
    if ((Number(snapshot.pendingImages) || 0) > 0) return "images";
    if ((Number(snapshot.skeletons) || 0) > 0) return "skeleton";
  }
  const previousHeight = Number(previousSnapshot?.feedHeight);
  if (previousSnapshot && Number.isFinite(feedHeight) && Number.isFinite(previousHeight) && feedHeight - previousHeight > HOLD_GROWTH_PX) {
    return "posts-growing";
  }
  const feedShort = !feedTall || mediaPending;
  if (railsEmpty && feedShort) return "rails";
  return null;
}

export const FEED_STALL_MS = 90_000;
export const FEED_STALL_RECOVERIES = 2;

// A column that keeps scrolling but stops adding unique posts (yo-yo at the end of a feed
// that never loads more) is stalled, not stuck. Two recoveries, then the feed step ends.
export function noteFeedProgress(stats, now = Date.now()) {
  if (stats.progressCount == null || stats.postsSeen > stats.progressCount) {
    stats.progressCount = stats.postsSeen;
    stats.lastNewPostAt = now;
    return null;
  }
  if (now - (stats.lastNewPostAt ?? now) < FEED_STALL_MS) return null;
  stats.feedStalled = true;
  stats.lastNewPostAt = now;
  stats.feedStalls = (stats.feedStalls || 0) + 1;
  return stats.feedStalls <= FEED_STALL_RECOVERIES ? "recover" : "end";
}

// A hold is not a stuck scroll. Four separate still-loading passes end the feed step.
export const PAINTED_HOLD_LIMIT = 8;

export function noteStillLoadingScroll(stats, scrolled) {
  if (scrolled?.stillLoading) {
    stats.stuck = 0;
    // A pass held on a page that already looks painted (only still growing) is not a
    // loading screen. It does not count toward the stop, up to a cap so it cannot
    // hold the whole session.
    const shot = scrolled.snapshot || scrolled.before;
    if (feedLooksPainted(shot) && (stats.paintedHolds || 0) < PAINTED_HOLD_LIMIT) {
      stats.paintedHolds = (stats.paintedHolds || 0) + 1;
      return { held: true, stop: false, reason: scrolled.reason || null };
    }
    stats.loadingPasses = (stats.loadingPasses || 0) + 1;
    const stop = stats.loadingPasses >= FEED_LOADING_PASS_LIMIT;
    return {
      held: true,
      stop,
      reason: stop ? "Feed stayed on a loading screen" : (scrolled.reason || null),
    };
  }
  if (scrolled?.held || scrolled?.healed) {
    stats.stuck = 0;
    if (scrolled.healed) stats.loadingPasses = 0;
    return { held: Boolean(scrolled.held), stop: false, reason: null };
  }
  const moved = Number(scrolled?.moved);
  if (scrolled && scrolled.empty !== true && scrolled.moved !== null && Number.isFinite(moved) && Math.abs(moved) >= 8) {
    stats.loadingPasses = 0;
  }
  return { held: false, stop: false, reason: null };
}

function endLoadingScreen(result, stats, scrolled) {
  const pace = noteStillLoadingScroll(stats, scrolled);
  if (!pace.stop) return pace;
  result.aborted = true;
  result.failureKind = "infra";
  result.reason = pace.reason;
  log.warn("Feed stayed on a loading screen. Ending the feed step.", {
    reason: scrolled?.reason || pace.reason,
    loadingPasses: stats.loadingPasses,
  });
  return pace;
}

export const SHORT_PAINT_SAMPLES = 6;

// The load hold for a short first screen. A column that is still painting or still
// growing is not a thin feed: wait for it before See new posts or any Follow press.
// grown: it is no longer short. painted: settled and still short. stillLoading: gave up waiting.
export async function awaitShortColumnPaint({ readSnapshot, readCount, pause = sleepJitter, samples = SHORT_PAINT_SAMPLES } = {}) {
  let previous = null;
  let previousCount = null;
  let snapshot = null;
  let count = 0;
  let reason = null;
  for (let sample = 0; sample <= samples; sample += 1) {
    snapshot = await readSnapshot().catch(() => null);
    count = await readCount();
    const maxTop = Number(snapshot?.maxTop);
    if (count >= 5 || (Number.isFinite(maxTop) && maxTop >= SHORT_COLUMN_MAX)) {
      return { grown: true, painted: true, stillLoading: false, postsSeen: count, snapshot, samples: sample };
    }
    reason = scrollHoldReason(snapshot, previous);
    const steady = previous != null
      && Math.abs((Number(snapshot?.feedHeight) || 0) - (Number(previous.feedHeight) || 0)) <= HOLD_GROWTH_PX
      && count === previousCount;
    if (!reason && steady) return { grown: false, painted: true, stillLoading: false, postsSeen: count, snapshot, samples: sample };
    if (sample === samples) break;
    previous = snapshot;
    previousCount = count;
    await pause(FEED_PAINT_WAIT_MIN_MS, FEED_PAINT_WAIT_MAX_MS);
  }
  return { grown: false, painted: !reason, stillLoading: Boolean(reason), reason, postsSeen: count, snapshot, samples };
}

const FEED_PAINT_WAIT_MIN_MS = 1200;
const FEED_PAINT_WAIT_MAX_MS = 2500;

// Few posts from a feed that showed loading trouble is a slow paint or a stalled feed,
// not an account problem.
export function feedLoadTrouble(stats = {}) {
  return Boolean(stats.loadingSeen || (stats.loadingPasses || 0) > 0 || stats.feedStalled || stats.shortColumnSeen || stats.connectionClosed);
}

async function waitForUniqueGrowth(readCount, before, { waitMs = 12_000, pause = sleepJitter } = {}) {
  let latest = await readCount();
  const deadline = Date.now() + waitMs;
  while (latest <= before && Date.now() < deadline) {
    await pause(700, 1200);
    latest = await readCount();
  }
  return latest;
}

const THIN_FEED_FOLLOW_CAP = 3;

// Thin-feed follows use the same optimizer gate and reservation as every other follow:
// people only, the plan's followCap (0 means none), the session and daily hard caps, one
// try per profile URL. Without a gate nothing is pressed.
export function thinFollowGate(optimizer, { started = Date.now(), endsAt = Infinity, considered = new Set(), deniedReasons = {} } = {}) {
  const deny = (reason) => {
    deniedReasons[reason] = (deniedReasons[reason] || 0) + 1;
    return { allow: false, reason };
  };
  return {
    approve(control, stats) {
      if (!optimizer?.plan) return deny("No plan.");
      if (control.kind !== "person") return deny("Thin-feed company follows are not allowed; follows are people only.");
      const profileUrl = /\/$/.test(control.url || "") ? control.url : `${control.url || ""}/`;
      if (considered.has(profileUrl)) return deny("Already considered this person in this session.");
      considered.add(profileUrl);
      const candidate = { profileUrl, source: "suggested", promoted: false };
      const gate = optimizer.gateFollow({ candidate, stats, elapsedMs: Date.now() - started, remainingMs: endsAt - Date.now() });
      if (!gate.allow) return deny(gate.reason);
      const actionId = optimizer.reserveFollow(candidate);
      if (!actionId) return deny("Follow reservation refused (daily cap or already followed).");
      return { allow: true, actionId };
    },
    finish(actionId, confirmed) {
      optimizer.finishFollow(actionId, confirmed);
    },
  };
}

// Only for a feed that still has fewer than 5 unique posts. Every press goes through
// `followGate`; a session without one presses nothing.
export async function recoverThinFeedFollows(page, human, stats, { pause = sleepJitter, countUnique, waitMs = 12_000, followGate = null } = {}) {
  if ((stats.postsSeen || 0) >= 5) return { followed: [] };
  if (stats.thinFeedFollowRecovery) return { followed: [] };
  stats.thinFeedFollowRecovery = true;
  const before = stats.postsSeen || 0;
  let plan = { ready: [], blocked: [] };
  try {
    const scanned = await scanThinFeedFollowPlan(page);
    plan = scanned && Array.isArray(scanned.ready) ? scanned : plan;
  } catch (error) {
    if (isInfrastructureFailure(error)) throw error;
    log.warn("Thin-feed follow scan failed.", { message: error.message, postsSeen: before });
  }
  const ready = plan.ready || [];
  const blocked = plan.blocked || [];
  if (!ready.length && !blocked.length) {
    log.info("No person or company Follow control was on screen.", { postsSeen: before });
    return { followed: [], postsSeen: before };
  }
  log.info("Thin feed Follow controls.", {
    postsSeen: before,
    ready: ready.map((item) => ({ name: item.name, kind: item.kind, url: item.url, hitLabel: item.hitLabel })),
    blocked: blocked.map((item) => ({ name: item.name, kind: item.kind, url: item.url, hitLabel: item.hitLabel })),
  });
  for (const control of blocked) {
    log.info("Thin-feed follow attempt.", {
      name: control.name,
      kind: control.kind,
      url: control.url,
      hitLabel: control.hitLabel || "",
      pressed: false,
      following: false,
      skipped: true,
    });
  }
  const followed = [];
  const readCount = countUnique || (async () => stats.postsSeen || 0);
  let presses = 0;
  for (const control of ready) {
    if (presses >= THIN_FEED_FOLLOW_CAP) break;
    if (/ahmedi\s+ariwala/i.test(control.name || "")) {
      log.info("Thin-feed follow attempt.", {
        name: control.name,
        kind: control.kind,
        url: control.url,
        hitLabel: control.hitLabel || "",
        pressed: false,
        following: true,
        skipped: true,
      });
      continue;
    }
    const approval = followGate ? followGate.approve(control, stats) : { allow: false, reason: "No follow gate for this session." };
    if (!approval.allow) {
      log.info("Thin-feed follow not approved.", { name: control.name, kind: control.kind, url: control.url, reason: approval.reason });
      continue;
    }
    stats.followAttempts = (stats.followAttempts || 0) + 1;
    stats.lastFollowAt = Date.now();
    const postsBefore = stats.postsSeen || before;
    log.info("Thin-feed follow target.", {
      name: control.name,
      kind: control.kind,
      url: control.url,
      tag: control.tag,
      label: control.label,
      hitLabel: control.hitLabel || "",
      box: control.box,
    });
    let pressed = false;
    try {
      pressed = await human.clickAt(control.x, control.y, "thin-follow", control.url, { singlePress: true });
    } catch (error) {
      if (isInfrastructureFailure(error)) {
        followGate.finish(approval.actionId, false);
        throw error;
      }
      log.warn("Thin-feed Follow press failed.", { name: control.name, kind: control.kind, message: error.message });
    }
    presses += 1;
    if (!pressed) {
      followGate.finish(approval.actionId, false);
      log.info("Thin-feed follow attempt.", {
        name: control.name,
        kind: control.kind,
        url: control.url,
        hitLabel: control.hitLabel || "",
        pressed: false,
        following: false,
      });
      continue;
    }
    let following = false;
    try {
      if (await dialogOpen(page)) {
        log.warn("A dialog opened after Follow. Closing it without clicking inside.", { name: control.name, kind: control.kind });
        await page.keyboard?.press("Escape").catch(() => {});
        await pause(300, 700);
      }
      following = (await readThinFollowStatus(page, control.url)) === "following";
    } catch (error) {
      if (isInfrastructureFailure(error)) {
        followGate.finish(approval.actionId, false);
        throw error;
      }
    }
    followGate.finish(approval.actionId, following);
    if (following) stats.follows = (stats.follows || 0) + 1;
    log.info("Thin-feed follow attempt.", {
      name: control.name,
      kind: control.kind,
      url: control.url,
      hitLabel: control.hitLabel || control.label,
      pressed: true,
      following,
      postsSeen: postsBefore,
    });
    const after = await waitForUniqueGrowth(readCount, postsBefore, { waitMs, pause });
    stats.postsSeen = after;
    log.info("Unique posts after thin-feed follow.", {
      name: control.name,
      kind: control.kind,
      before: postsBefore,
      postsSeen: after,
    });
    if (following) followed.push({ name: control.name, kind: control.kind, url: control.url, postsSeen: after });
    if (after >= 5) break;
  }
  return { followed, postsSeen: stats.postsSeen || before };
}

// A short column that still has posts is not healthy: the scroller reverses once
// maxTop is past ~200 and the same few identities loop until the session ends.
// Click new-posts when it is on screen. If unique posts do not increase, load the
// real feed URL once. Never reload a chrome-error page. Never treat visible
// update nodes as an empty column.
export async function actOnShortColumn(page, human, stats, observed, { pause = sleepJitter, countUnique, waitMs = 12_000, settle = null, followGate = null } = {}) {
  const url = observed.url || safePageUrl(page);
  const postsBefore = observed.postsSeen ?? stats.postsSeen ?? 0;
  const reason = columnNeedsRevival({ ...observed, postsSeen: postsBefore, url });
  if (!reason) return { acted: false, clicked: false, loaded: false, gaveUp: false, postsSeen: postsBefore, reason: null };
  if (reason === "updates-present") {
    log.info("Collector returned no posts but update nodes are still on screen. Not reloading.", {
      postsSeen: postsBefore, url, visibleUpdates: observed.visibleUpdates, maxTop: observed.maxTop,
    });
    return { acted: false, clicked: false, loaded: false, gaveUp: false, postsSeen: postsBefore, reason, scroll: true };
  }

  log.info("Short column unique posts before revival.", {
    postsSeen: postsBefore,
    url,
    maxTop: observed.maxTop ?? null,
    firstTop: observed.firstTop ?? null,
    visibleUpdates: observed.visibleUpdates ?? 0,
    reason,
  });

  const readCount = countUnique || (async () => stats.postsSeen || 0);
  if (reason === "short") stats.shortColumnSeen = true;
  if (reason === "short" && typeof settle === "function") {
    const paint = await settle();
    if (Number.isFinite(paint?.postsSeen) && paint.postsSeen > (stats.postsSeen || 0)) stats.postsSeen = paint.postsSeen;
    if (paint?.grown) {
      log.info("Short column grew while the feed finished painting. Not reviving it.", {
        postsSeen: stats.postsSeen, before: postsBefore, maxTop: paint.snapshot?.maxTop ?? null, samples: paint.samples,
      });
      return { acted: false, clicked: false, loaded: false, gaveUp: false, postsSeen: stats.postsSeen, reason: null, scroll: true };
    }
    if (paint?.stillLoading) {
      stats.loadingSeen = true;
      log.info("Short column is still painting. Not pressing See new posts or Follow on a half-painted feed.", {
        postsSeen: stats.postsSeen, reason: paint.reason, maxTop: paint.snapshot?.maxTop ?? null, feedHeight: paint.snapshot?.feedHeight ?? null,
      });
      return { acted: true, clicked: false, loaded: false, gaveUp: false, stillLoading: true, postsSeen: stats.postsSeen, reason, scroll: false };
    }
  }
  if (reason === "chrome-error") {
    const recovered = await recoverChromeError(page, { pause });
    if (recovered.accountWall) {
      return { acted: true, clicked: false, loaded: false, gaveUp: false, accountWall: true, postsSeen: postsBefore, reason, scroll: false };
    }
    human.postsCacheAt = 0;
    const afterLoad = await waitForUniqueGrowth(readCount, postsBefore, { waitMs, pause });
    stats.postsSeen = afterLoad;
    return {
      acted: true,
      clicked: false,
      loaded: true,
      gaveUp: afterLoad <= postsBefore,
      postsSeen: afterLoad,
      reason,
      scroll: false,
    };
  }
  let clicked = false;
  const pill = !isChromeErrorUrl(url) ? observed.pill : null;
  if (pill && (stats.seeNewMisses || 0) < 2) {
    log.info("See new posts is on screen. Clicking it so the next posts can load.", {
      label: pill.label,
      tag: pill.tag || null,
      box: pill.box || null,
      postsSeen: postsBefore,
      url,
    });
    clicked = await human.clickAt(pill.x, pill.y, "see-new");
    if (!clicked) {
      stats.seeNewMisses = (stats.seeNewMisses || 0) + 1;
      log.warn("New posts is listed on the feed but the press did not land.", { label: pill.label, postsSeen: postsBefore });
    } else {
      stats.seeNewPosts = (stats.seeNewPosts || 0) + 1;
      stats.seeNewMisses = 0;
      human.postsCacheAt = 0;
      const afterClick = await waitForUniqueGrowth(readCount, postsBefore, { waitMs, pause });
      stats.postsSeen = afterClick;
      log.info("Unique posts after new-posts click.", { postsSeen: afterClick, before: postsBefore, url: safePageUrl(page) });
      if (afterClick > postsBefore) {
        return { acted: true, clicked: true, loaded: false, gaveUp: false, postsSeen: afterClick, reason, scroll: afterClick >= 5 };
      }
    }
  }

  if (reason === "short") {
    const recovery = await recoverThinFeedFollows(page, human, stats, { pause, countUnique: readCount, waitMs, followGate });
    const afterFollows = stats.postsSeen || postsBefore;
    const gaveUp = afterFollows < 5;
    if (gaveUp) {
      log.info("Short feed did not gain unique posts from revival.", {
        postsSeen: afterFollows,
        url: safePageUrl(page),
        maxTop: observed.maxTop ?? null,
        followed: recovery.followed || [],
      });
    }
    return {
      acted: true,
      clicked,
      loaded: false,
      gaveUp,
      postsSeen: afterFollows,
      reason,
      scroll: afterFollows >= 5,
      followed: recovery.followed || [],
    };
  }

  let loaded = false;
  if ((stats.feedUrlLoads || 0) < 1) {
    loaded = await hardRefreshFeed(page, stats, { pause });
    human.postsCacheAt = 0;
    const afterLoad = await waitForUniqueGrowth(readCount, postsBefore, { waitMs, pause });
    stats.postsSeen = afterLoad;
    const settled = safePageUrl(page);
    log.info("Unique posts after hard refresh.", { postsSeen: afterLoad, before: postsBefore, url: settled, loaded });
    if (isChromeErrorUrl(settled)) {
      return { acted: true, clicked, loaded: false, gaveUp: true, postsSeen: afterLoad, reason, scroll: false };
    }
    if (afterLoad > postsBefore) {
      return { acted: true, clicked, loaded, gaveUp: false, postsSeen: afterLoad, reason, scroll: true };
    }
  }

  const stillBad = columnNeedsRevival({
    postsSeen: stats.postsSeen || postsBefore,
    maxTop: observed.maxTop,
    firstTop: observed.firstTop,
    url: safePageUrl(page),
  });
  const gaveUp = Boolean(stillBad && stillBad !== "updates-present");
  if (gaveUp) {
    log.info("Short feed did not gain unique posts. Not scrolling the same column.", {
      postsSeen: stats.postsSeen || postsBefore,
      url: safePageUrl(page),
      maxTop: observed.maxTop ?? null,
    });
  }
  return {
    acted: true,
    clicked,
    loaded,
    gaveUp,
    postsSeen: stats.postsSeen || postsBefore,
    reason,
    scroll: false,
  };
}

// A See new posts click can blank the column for one read even after posts were
// already collected. Reloading that blank read navigates away and can drop the
// connection before the planned scroll. Keep scrolling those posts instead.
export function emptyCollectorAction({ nullRoot = false, visibleUpdates = 0, postsSeen = 0, seeNewMisses = 0 } = {}) {
  if (nullRoot) return "reload-root";
  if (visibleUpdates > 0) return "keep";
  if (postsSeen > 0 && seeNewMisses > 0) return "scroll";
  return "reload";
}

// Kept for callers that used to reload an empty viewport. It loads the real feed
// URL at most once and refuses to reload a browser error page or a column that
// still has update nodes.
export async function refreshEmptyFeed(page, stats, options = {}) {
  const url = safePageUrl(page);
  if (isChromeErrorUrl(url)) {
    log.warn("Refusing to reload a browser error page.", { url });
    return loadRealFeed(page, stats, options);
  }
  if ((options.visibleUpdates || 0) > 0) {
    log.info("Update nodes are still on screen. Not refreshing an empty collector.", { url, visibleUpdates: options.visibleUpdates });
    return false;
  }
  log.info("No visible posts. Loading the feed URL instead of scrolling.");
  return loadRealFeed(page, stats, options);
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

// The More control is located before the optimizer is asked, so a control that is not
// on the page never takes an expand approval.
export async function approveExpand(page, optimizer, post, stats, { locate = locateControl } = {}) {
  let point = null;
  try {
    point = await locate(page, post.urn, "more");
  } catch (error) {
    rethrowInfrastructure(error);
  }
  if (!point) {
    log.debug("More control not locatable; not asking for an expand approval.", { urn: post.urn });
    return { allow: false, located: false, reason: "More control not locatable." };
  }
  return { ...optimizer.gateExpand({ post, stats }), located: true };
}

export async function expandPost(page, human, post) {
  const result = await clickFresh(page, human, post.urn, "more");
  if (!result.ok) {
    log.warn("Approved More expand did not run.", { urn: post.urn, why: result.why });
    return false;
  }
  log.info("Expanded post via More.", { urn: post.urn });
  await human.waitAfterExpand();
  return true;
}

export async function likePost(page, human, post) {
  await dismissReactionMenu(page);
  await dismissMediaOverlay(page);
  const first = await clickFresh(page, human, post.urn, "like", { shortPress: true });
  if (!first.ok) return false;
  await sleepJitter(350, 900);
  if (await dismissMediaOverlay(page)) {
    log.warn("Like click opened media. Closing overlay.", { urn: post.urn });
    return false;
  }
  if (await reactionMenuOpen(page)) {
    // Escape once and read the state. Like is never pressed a second time.
    log.info("Reaction picker opened. Pressing Escape once and checking whether the like stuck.", { urn: post.urn });
    await page.keyboard.press("Escape");
    await sleepJitter(300, 700);
    const likedAfterPicker = await postIsLiked(page, post.urn);
    if (!likedAfterPicker) log.warn("Like click did not stick.", { urn: post.urn, label: first.point?.label, why: "reaction-picker" });
    return likedAfterPicker;
  }
  const liked = await postIsLiked(page, post.urn);
  if (!liked) log.warn("Like click did not stick.", { urn: post.urn, label: first.point?.label });
  return liked;
}

// Exactly one pointer click per person: no re-hover, no second locate, no retry.
export async function followPerson(page, human, candidate) {
  const point = await human.revealControl(candidate.profileUrl, "follow", { locate: locateFollow });
  if (!point) {
    log.info("Follow control is no longer on screen. Skipping this person.", { profileUrl: candidate.profileUrl });
    return false;
  }
  const clicked = await human.clickAt(point.x, point.y, "follow", candidate.profileUrl, { singlePress: true });
  if (clicked) await sleepJitter(900, 1700);
  else log.warn("Follow hit check failed or the press was uncertain. Not clicking this person again.", { profileUrl: candidate.profileUrl });
  if (await dialogOpen(page)) {
    log.warn("A dialog opened after Follow. Closing it without clicking inside.", { profileUrl: candidate.profileUrl });
    await page.keyboard.press("Escape").catch(() => {});
    await sleepJitter(300, 700);
  }
  return (await followState(page, candidate.profileUrl)) === "following";
}

export async function maybeFollow(page, human, optimizer, stats, { started, endsAt, considered, deniedReasons = {}, signal } = {}) {
  const cap = Math.min(optimizer.plan?.followCap ?? 0, config.follow.hardCapPerSession);
  if (cap <= 0 || stats.followAttempts >= cap) return false;
  const onScreen = await findFollowCandidates(page);
  stats.followButtonsSeen = (stats.followButtonsSeen || 0) + onScreen.length;
  const candidates = onScreen.filter((c) => !considered.has(c.profileUrl));
  if (!candidates.length) return false;
  const candidate = candidates[randomInt(0, candidates.length - 1)];
  // Each person gets one roll per session, so a row that stays on screen does not
  // accumulate chances across loop iterations.
  considered.add(candidate.profileUrl);
  const gate = optimizer.gateFollow({ candidate, stats, elapsedMs: Date.now() - started, remainingMs: endsAt - Date.now() });
  if (!gate.allow) {
    deniedReasons[gate.reason] = (deniedReasons[gate.reason] || 0) + 1;
    return false;
  }
  const actionId = optimizer.reserveFollow(candidate);
  if (!actionId) return false;
  stats.followAttempts += 1;
  stats.lastFollowAt = Date.now();
  if (candidate.source === "recommended") stats.recommendedFollows += 1;
  let followed = false;
  try {
    signal?.throwIfAborted();
    followed = await followPerson(page, human, candidate);
  } catch (error) {
    log.error("Follow click failed; its reservation is retained.", { message: error.message });
    if (isInfrastructureFailure(error)) {
      optimizer.finishFollow(actionId, false);
      throw error;
    }
  }
  optimizer.finishFollow(actionId, followed);
  if (followed) {
    stats.follows += 1;
    log.info("Followed a person from the feed.", { source: candidate.source, profileUrl: candidate.profileUrl, follows: stats.follows });
  } else {
    log.warn("Follow did not confirm. Not retrying.", { source: candidate.source, profileUrl: candidate.profileUrl });
  }
  return followed;
}

// Profile and company pages are not opened from the feed. The argument list stays so older
// callers fail closed instead of navigating.
export async function maybeVisitFromFeed() {
  return { visited: false, reason: "profile-views-disabled" };
}

async function stayAwhile(human, post, ms, { signal, onHeartbeat = () => {} } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    onHeartbeat();
    const x = (human.pointer?.x || post.midX || 480) + randomInt(-16, 16);
    const y = (human.pointer?.y || post.midY || 360) + randomInt(-14, 14);
    await human.driftTo(x, y);
    await sleepJitter(550, 1200);
  }
}

export async function dwellOnPost(human, post, options = {}) {
  const dwellMs = randomInt(4_000, 14_000);
  await stayAwhile(human, post, dwellMs, options);
  return dwellMs;
}

// Feed videos autoplay muted. The only control LinkedIn shows is "Unmute", and pressing it
// would play sound, so the player is never pressed: hover, then watch in place.
export async function watchFeedVideo(page, human, post, options = {}) {
  const hoverX = post.midX || 480;
  const hoverY = Math.max(160, Math.min((post.top || 200) + 180, post.midY || 420));
  await human.moveTo(hoverX, hoverY);
  await sleepJitter(450, 900);
  const watchMs = randomInt(8_000, 20_000);
  log.info("Watching a feed video.", { urn: post.urn, watchMs });
  await stayAwhile(human, post, watchMs, options);
  return { watched: true, toggledMute: false, watchMs };
}

// Back, then the Home nav (twice at most). A view is a normal detour, so recoverHomeFeed
// should find the tab already on /feed/.
async function returnToFeed(page, human, onHeartbeat = () => {}) {
  let homeClicks = 0;
  const clickHome = async () => {
    const home = await homeNavPoint(page);
    if (!home) {
      const topLinks = await page.evaluate(() => [...document.querySelectorAll("a[href]")]
        .filter((a) => { const r = a.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.top < 90; })
        .map((a) => `${(a.getAttribute("href") || "").split("?")[0].slice(0, 50)} | ${(a.getAttribute("aria-label") || a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 30)}`)
        .slice(0, 12)).catch((error) => [`error: ${error.message}`]);
      log.info("Home nav link was not found on this page.", { url: page.url(), topLinks });
      return;
    }
    homeClicks += 1;
    const clicked = await human.clickAt(home.x, home.y, "home");
    log.info("Pressed Home in the LinkedIn nav.", { clicked, from: page.url() });
  };
  const back = await returnFrom(page, { matches: (path) => /^\/feed\/?$/.test(path), fallback: clickHome, reloadUrl: FEED_URL, onHeartbeat });
  if (back || isOnHomeFeed(page.url())) return true;
  if (homeClicks < 2) {
    try { await clickHome(); }
    catch (error) { if (!/detached Frame|Execution context|navigation/i.test(error.message)) throw error; }
    for (let poll = 0; poll < 20 && !isOnHomeFeed(page.url()); poll += 1) { onHeartbeat(); await sleepJitter(300, 500); }
  }
  return isOnHomeFeed(page.url());
}

async function absorbUniquePosts(page, seen, stats) {
  let posts = [];
  try {
    posts = await collectPosts(page);
  } catch (error) {
    if (isNullFeedRootError(error) || !isInfrastructureFailure(error)) return stats.postsSeen || 0;
    throw error;
  }
  for (const post of posts) {
    if (!post?.urn || seen.has(post.urn)) continue;
    seen.add(post.urn);
    stats.postsSeen += 1;
  }
  return stats.postsSeen || 0;
}

async function readRevivalObservation(page, human) {
  const url = safePageUrl(page);
  if (isChromeErrorUrl(url)) return { url, pill: null, visibleUpdates: 0, maxTop: null, firstTop: null };
  const column = await readFeedColumn(page);
  const offset = await human.scrollOffset();
  const pill = await findSeeNewPosts(page);
  return {
    url,
    maxTop: Number.isFinite(offset?.maxTop) ? offset.maxTop : column?.maxTop,
    firstTop: Number.isFinite(offset?.firstTop) ? offset.firstTop : null,
    visibleUpdates: column?.visibleUpdates || 0,
    pill,
  };
}

async function reviveShortColumn(page, human, stats, seen, followGate = null) {
  if (stats.seeNewPostsAtRecovery == null) stats.seeNewPostsAtRecovery = stats.seeNewPosts || 0;
  let observed;
  try {
    observed = await readRevivalObservation(page, human);
  } catch (error) {
    if (!isNullFeedRootError(error)) throw error;
    log.warn("Feed root was missing. Loading the feed URL instead of aborting.", { message: error.message, postsSeen: stats.postsSeen });
    const loaded = await loadRealFeed(page, stats);
    return { acted: true, loaded, gaveUp: !loaded, postsSeen: stats.postsSeen, scroll: false, reason: "null-root" };
  }
  // A revival that already gave up on this exact column is not re-run every loop pass;
  // that spun the browse loop hundreds of times without scrolling or waiting.
  const key = `${stats.postsSeen}|${observed.maxTop}|${observed.url}|${observed.pill ? 1 : 0}`;
  if (stats.lastRevival?.key === key) return { ...stats.lastRevival.result, acted: false, repeat: true };
  const countUnique = () => absorbUniquePosts(page, seen, stats);
  const result = await actOnShortColumn(page, human, stats, { ...observed, postsSeen: stats.postsSeen }, {
    countUnique,
    followGate,
    settle: () => awaitShortColumnPaint({ readSnapshot: () => readFeedLoadSnapshot(page), readCount: countUnique }),
  });
  const revival = { ...result, maxTop: result.maxTop ?? observed.maxTop ?? null };
  stats.lastRevival = revival.gaveUp ? { key: `${stats.postsSeen}|${observed.maxTop}|${observed.url}|${observed.pill ? 1 : 0}`, result: revival } : null;
  return revival;
}

export function shortFeedAbortReason({ seeNewPosts = 0, seeNewPostsAtRecovery = 0, feedUrlLoads = 0 } = {}) {
  const pressed = seeNewPosts > seeNewPostsAtRecovery;
  const loaded = feedUrlLoads > 0;
  if (pressed && loaded) return "Short feed did not gain unique posts after a new-posts click and one feed URL load";
  if (pressed) return "Short feed did not gain unique posts after a new-posts click";
  if (loaded) return "Short feed did not gain unique posts after one feed URL load";
  return "Short feed did not gain unique posts";
}

function finishLoadingScreen(result, stats, started, reportProgress) {
  result.postsSeen = stats.postsSeen;
  result.likes = stats.likes;
  result.seeNewPosts = stats.seeNewPosts;
  result.durationMs = Date.now() - started;
  reportProgress();
  return result;
}

function finishShortFeed(result, stats, started, reportProgress) {
  result.aborted = true;
  result.reason = shortFeedAbortReason(stats);
  result.postsSeen = stats.postsSeen;
  result.seeNewPosts = stats.seeNewPosts;
  result.durationMs = Date.now() - started;
  reportProgress();
  return result;
}

export async function runLinkedInFeed(page, plan, optimizer, { signal, onHeartbeat = () => {}, onProgress = () => {} } = {}) {
  closeUnexpectedTabs(page);
  let human = new HumanController(page);
  let frameDetachRetries = 0;
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
    seeNewMisses: 0,
    follows: 0,
    followAttempts: 0,
    recommendedFollows: 0,
    lastFollowAt: 0,
    feedVisits: 0,
    visits: 0,
    postDwells: 0,
    videosWatched: 0,
    feedUrlLoads: 0,
    loadingPasses: 0,
  };
  const followConsidered = new Set();
  let leftFeed = false;
  const seen = new Set();
  const handled = new Set();
  const deniedReasons = deniedTally();
  const followGate = thinFollowGate(optimizer, { started, endsAt, considered: followConsidered, deniedReasons });
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
  const reportProgress = () => onProgress({
    likes: stats.likes,
    postsSeen: stats.postsSeen,
    expanded: stats.expanded,
    seeNewPosts: stats.seeNewPosts,
  });

  const opened = await openFeed(page, human);
  let block = opened.block ? { blocked: true, ...opened.block } : { blocked: false };
  if (!block.blocked) {
    try {
      block = await detectBlock(page);
    } catch (error) {
      rethrowInfrastructure(error);
      // A detached frame cannot be inspected, but the browser's URLs still can.
      const wall = await observedAccountBlock(browserOf(page), page);
      if (wall) block = { blocked: true, ...wall };
      else log.warn("Initial account inspect timed out; continuing if the feed looks reachable.", { message: error.message });
    }
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
  let readyPosts = await waitForPosts(page, human);
  if (readyPosts.length === 0) {
    const revival = await reviveShortColumn(page, human, stats, seen, followGate);
    if (!(revival.gaveUp && stats.postsSeen < 1)) readyPosts = await waitForPosts(page, human);
    if (readyPosts.length === 0 && stats.postsSeen < 1) {
      log.error("LinkedIn /feed/ rendered with zero posts. Not scrolling a blank page.");
      result.aborted = true;
      result.reason = "Feed rendered without readable posts";
      result.durationMs = Date.now() - started;
      return result;
    }
  }
  for (const post of readyPosts) {
    if (!seen.has(post.urn)) {
      seen.add(post.urn);
      stats.postsSeen += 1;
    }
  }
  reportProgress();
  await writeFeedDump(page, "feed-dom-found");
  log.info("Posts are in the DOM. Starting human scroll with pointer tracking.", { count: readyPosts.length, postsSeen: stats.postsSeen });
  let opening = { acted: false, gaveUp: false };
  try {
    opening = await reviveShortColumn(page, human, stats, seen, followGate);
  } catch (error) {
    rethrowInfrastructure(error);
    log.warn("Short-column revival failed. Continuing.", { message: error.message });
  }
  if (opening.accountWall) {
    const held = await requireHomeFeed(page, stats, result);
    if (held !== "home") {
      result.durationMs = Date.now() - started;
      return result;
    }
  }
  if (opening.stillLoading && endLoadingScreen(result, stats, { stillLoading: true, reason: opening.reason }).stop) {
    return finishLoadingScreen(result, stats, started, reportProgress);
  }
  // A short first screen that already has posts is a real feed. Follows are
  // optional. Do not abort before the planned scroll has run.
  if (opening.gaveUp && stats.postsSeen < 1 && !(Number(opening.maxTop) > 200)) return finishShortFeed(result, stats, started, reportProgress);
  if (!(opening.acted && stats.postsSeen < 1)) {
    try {
      const settled = await readFeedColumn(page);
      if (settled && !settled.feedVisible) {
        log.warn("Feed list is outside the viewport before browsing. Pulling it back.", settled);
        await healFeedColumn(page);
        await sleepJitter(400, 800);
      }
    } catch (error) {
      rethrowInfrastructure(error);
      log.warn("Feed column check failed. Continuing.", { message: error.message });
    }
    try {
      const startPos = await human.scrollOffset();
      if (startPos.maxTop > COLLAPSED_MAX && (startPos.top >= startPos.maxTop - 8 || startPos.top > 8000)) {
        // A short column, or one a Follow aim just centred, sits at its end. Jumping to the
        // new-posts pill from here unmounts the posts, so scroll back up through the paint hold.
        log.warn("Feed column is already at its end on open. Scrolling back up gently instead of jumping.", {
          ...startPos, shortColumn: startPos.maxTop < SHORT_COLUMN_MAX, afterFollowAim: Boolean(stats.thinFeedFollowRecovery),
        });
        const back = await human.scrollFeed({ forceReverse: true });
        if (endLoadingScreen(result, stats, back).stop) return finishLoadingScreen(result, stats, started, reportProgress);
        const stuck = !back.held && !back.empty && back.moved !== null && Math.abs(Number(back.moved) || 0) < 8;
        if (stuck && startPos.maxTop >= SHORT_COLUMN_MAX) await refreshStaleFeed(page, human, stats);
      } else if (Number.isFinite(startPos.maxTop) && startPos.maxTop <= COLLAPSED_MAX) {
        log.warn("Feed scroller has no travel. Not scrolling it.", startPos);
      } else if (Number.isFinite(startPos.firstTop) && startPos.firstTop > startPos.maxTop + 160) {
        log.warn("First post is below the scroller's reach. Not scrolling it.", startPos);
      } else {
        const firstScroll = await human.scrollFeed({ reverseChance: 0 });
        log.info("Initial feed scroll.", firstScroll);
        if (endLoadingScreen(result, stats, firstScroll).stop) return finishLoadingScreen(result, stats, started, reportProgress);
      }
    } catch (error) {
      rethrowInfrastructure(error);
      log.warn("Initial scroll failed. Continuing if the page is still alive.", { message: error.message });
    }
  }

  if (plan.glanceNotifications) {
    log.info("Glancing at notifications without opening them.");
    await maybeGlanceNotifications(page, human);
  }

  log.info("Browsing LinkedIn home feed.", {
    sessionMin: Math.round(plan.sessionMs / 6000) / 10,
    likeCap: plan.likeCap,
    followCap: optimizer.plan?.followCap ?? 0,
    likeRate: Number(plan.likeRate.toFixed(3)),
    expandRate: Number(plan.expandRate.toFixed(3)),
    reverseScrollChance: plan.reverseScrollChance,
  });

  while (Date.now() < endsAt) {
    onHeartbeat();
    signal?.throwIfAborted();
    const remainingMs = endsAt - Date.now();
    const elapsedMs = Date.now() - started;
    let liveBlock;
    try {
      liveBlock = await detectBlock(page);
    } catch (error) {
      if (isInfrastructureFailure(error)) throw error;
      if (isDetachedFrameError(error)) {
        let live = null;
        if (frameDetachRetries < 2) {
          frameDetachRetries += 1;
          try { live = await waitForLiveLinkedInPage(browserOf(page)); }
          catch (recoverError) {
            if (!isDetachedFrameError(recoverError)) log.warn("Could not look for a live LinkedIn page.", { message: recoverError.message });
          }
        }
        if (detachedInspectAction(error, live)?.action === "continue") {
          page = live;
          human = new HumanController(page);
          log.warn("Detached frame during account inspect. Continuing on a live LinkedIn page.", { url: readPageUrl(page), postsSeen: stats.postsSeen });
          continue;
        }
        if (stats.postsSeen >= 5) {
          log.warn("Feed tab closed after a productive browse and no live LinkedIn page is left. Keeping the browse result.", { message: error.message, postsSeen: stats.postsSeen });
          result.pageLost = true;
          result.reason = `Feed tab closed after ${stats.postsSeen} posts; the browse result was kept`;
          break;
        }
        log.warn("Detached frame and no live LinkedIn page. Ending as an infrastructure failure.", { message: error.message, postsSeen: stats.postsSeen });
        result.aborted = true;
        result.failureKind = "infra";
        result.reason = error.message;
        break;
      }
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
    const held = await requireHomeFeed(page, stats, result);
    if (held === "blocked") break;
    if (held === "left") {
      leftFeed = true;
      break;
    }

    let revival = { acted: false, gaveUp: false, clicked: false };
    try {
      revival = await reviveShortColumn(page, human, stats, seen, followGate);
    } catch (error) {
      if (isInfrastructureFailure(error)) throw error;
      log.warn("Short-column revival failed. Continuing.", { message: error.message });
    }
    if (revival.accountWall) {
      const heldAfterRevival = await requireHomeFeed(page, stats, result);
      if (heldAfterRevival !== "home") {
        if (heldAfterRevival === "left") leftFeed = true;
        break;
      }
    }
    if (revival.stillLoading) {
      const pace = endLoadingScreen(result, stats, { stillLoading: true, reason: revival.reason });
      if (pace.stop) break;
      continue;
    }
    if (revival.gaveUp && stats.postsSeen < 1 && !(Number(revival.maxTop) > 200)) {
      finishShortFeed(result, stats, started, reportProgress);
      break;
    }
    if (Number(revival.maxTop) > 200 && stats.postsSeen < 1) {
      stats.shortPasses = (stats.shortPasses || 0) + 1;
      if (stats.shortPasses > 6) {
        finishShortFeed(result, stats, started, reportProgress);
        break;
      }
    }
    if (revival.acted && stats.postsSeen < 1 && !(Number(revival.maxTop) > 200)) {
      stats.stuck = 0;
      continue;
    }

    let loadedMore = false;
    if (stats.stuck >= 2) {
      const refreshed = await refreshStaleFeed(page, human, stats);
      loadedMore = refreshed;
      if (!refreshed) {
        try {
          const backed = await human.scrollFeed({ forceReverse: true });
          const pace = endLoadingScreen(result, stats, backed);
          if (pace.stop) break;
          if (pace.held) continue;
        } catch (error) {
          rethrowInfrastructure(error);
          log.warn("Unstick scroll failed, continuing browse.", { message: error.message });
        }
      }
    } else if (!revival.clicked) {
      loadedMore = await maybeSeeNewPosts(page, human, stats);
    }

    let posts = [];
    try {
      posts = await collectPosts(page);
      if (!posts.length) {
        // After onboarding/scroll, updates can sit just outside the readable band.
        posts = await collectPosts(page, { reveal: true });
      }
    } catch (error) {
      if (isInfrastructureFailure(error)) throw error;
      if (isNullFeedRootError(error)) {
        log.warn("Feed root was missing. Loading the feed URL instead of aborting.", { message: error.message, postsSeen: stats.postsSeen });
        const loaded = await loadRealFeed(page, stats).catch((loadError) => {
          log.warn("Feed URL load failed.", { message: loadError.message });
          return false;
        });
        if (loaded) {
          stats.stuck = 0;
          continue;
        }
        result.aborted = true;
        result.reason = "Feed root missing; feed URL load did not recover";
        break;
      }
      log.warn("Post collect timed out; ending browse with posts already seen.", { message: error.message, postsSeen: stats.postsSeen });
      result.reason = error.message;
      if (!(plan.testRun && stats.postsSeen > 0)) result.aborted = true;
      break;
    }
    if (!posts.length) {
      const column = await readFeedColumn(page).catch((error) => (isNullFeedRootError(error) ? { nullRoot: true } : null));
      const emptyAction = emptyCollectorAction({
        nullRoot: Boolean(column?.nullRoot),
        visibleUpdates: column?.visibleUpdates || 0,
        postsSeen: stats.postsSeen,
        seeNewMisses: stats.seeNewMisses || 0,
      });
      if (emptyAction === "reload-root") {
        const loaded = await loadRealFeed(page, stats).catch(() => false);
        if (loaded) {
          stats.stuck = 0;
          continue;
        }
        result.aborted = true;
        result.reason = "Feed root missing; feed URL load did not recover";
        break;
      }
      if (emptyAction === "keep") {
        log.info("Collector returned no posts but update nodes are still on screen. Not reloading.", {
          postsSeen: stats.postsSeen,
          url: safePageUrl(page),
          visibleUpdates: column.visibleUpdates,
          maxTop: column.maxTop,
        });
      } else if (emptyAction === "scroll") {
        log.info("See new posts click left no readable update nodes. Scrolling the posts already collected.", {
          postsSeen: stats.postsSeen,
          seeNewMisses: stats.seeNewMisses,
        });
      } else {
        try {
          const refreshed = await refreshEmptyFeed(page, stats, { visibleUpdates: column?.visibleUpdates || 0 });
          if (refreshed) {
            stats.stuck = 0;
            continue;
          }
        } catch (error) {
          rethrowInfrastructure(error);
          log.warn("Feed refresh failed.", { message: error.message });
          if (isConnectionDrop(error)) stats.connectionClosed = true;
        }
        if (stats.connectionClosed && stats.postsSeen > 0) {
          log.warn("Connection dropped during a feed reload. Posts were already on screen, so the planned scroll continues.", { postsSeen: stats.postsSeen });
          await sleepJitter(1500, 3000);
          stats.stuck = 0;
          continue;
        }
        log.info("No visible posts. Not scrolling an empty feed.");
        break;
      }
    }
    for (const post of posts) {
      if (!seen.has(post.urn)) {
        seen.add(post.urn);
        stats.postsSeen += 1;
      }
    }
    reportProgress();

    const stall = noteFeedProgress(stats);
    if (stall === "recover") {
      log.warn("No new unique posts while scrolling. Trying See new posts, then at most one feed URL load.", {
        postsSeen: stats.postsSeen, stalls: stats.feedStalls, feedUrlLoads: stats.feedUrlLoads || 0,
      });
      let grew = await maybeSeeNewPosts(page, human, stats);
      if (!grew && (stats.feedUrlLoads || 0) < 1) {
        try {
          grew = await hardRefreshFeed(page, stats);
        } catch (error) {
          rethrowInfrastructure(error);
          log.warn("Feed URL load after a stall failed.", { message: error.message });
          if (isConnectionDrop(error)) stats.connectionClosed = true;
        }
        human.postsCacheAt = 0;
      }
      stats.stuck = 0;
      continue;
    }
    if (stall === "end") {
      log.warn("Feed stopped loading new posts. Ending the feed step instead of scrolling the same column.", { postsSeen: stats.postsSeen });
      if (stats.postsSeen < 5) {
        result.aborted = true;
        result.failureKind = "infra";
        result.reason = `Feed stopped loading new posts after ${stats.postsSeen} unique posts`;
      }
      break;
    }

    if (stats.stuck >= 8) {
      if (await refreshStaleFeed(page, human, stats)) continue;
      try {
        const backed = await human.scrollFeed({ forceReverse: true });
        const pace = endLoadingScreen(result, stats, backed);
        if (pace.stop) break;
        if (pace.held) continue;
        if (backed.moved !== null && Math.abs(backed.moved) >= 8) {
          stats.stuck = 0;
          continue;
        }
      } catch (error) {
        rethrowInfrastructure(error);
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
        const expand = await approveExpand(page, optimizer, focus, stats);
        if (expand.allow) {
          try {
            didExpand = await expandPost(page, human, focus);
            if (didExpand) stats.expanded += 1;
            if (didExpand) reportProgress();
          } catch (error) {
            rethrowInfrastructure(error);
            log.warn("More expand failed, continuing browse.", { message: error.message });
          }
          const heldAfterExpand = await requireHomeFeed(page, stats, result);
          if (heldAfterExpand === "blocked") break;
          if (heldAfterExpand === "left") {
            leftFeed = true;
            break;
          }
        } else if (expand.located) {
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
            reportProgress();
            log.info("Liked a post.", { urn: fresh.urn, likes: stats.likes, expanded: didExpand });
            await sleepJitter(700, 1600);
          }
        } catch (error) {
          log.error("Like click failed; its budget reservation is retained.", { message: error.message });
          if (isInfrastructureFailure(error)) {
            optimizer.finishLike(actionId, false);
            throw error;
          }
        }
        optimizer.finishLike(actionId, liked);
      }
    }

    try {
      await maybeFollow(page, human, optimizer, stats, { started, endsAt, considered: followConsidered, deniedReasons, signal });
    } catch (error) {
      rethrowInfrastructure(error);
      log.warn("Follow step failed, continuing browse.", { message: error.message });
    }
    try {
      const watchCap = plan.videoWatchCap ?? 0;
      if (focus?.hasVideo && !focus.promoted && stats.videosWatched < watchCap && chance(plan.videoWatchChance ?? 0)) {
        const watch = await watchFeedVideo(page, human, focus, { signal, onHeartbeat });
        if (watch.watched) stats.videosWatched += 1;
      } else if (focus && !focus.promoted && chance(plan.postViewChance ?? 0)) {
        const dwellMs = await dwellOnPost(human, focus, { signal, onHeartbeat });
        stats.postDwells += 1;
        log.info("Stayed on a post.", { urn: focus.urn, dwellMs });
      }
    } catch (error) {
      rethrowInfrastructure(error);
      log.warn("Post dwell failed, continuing browse.", { message: error.message });
    }
    const heldAfterDwell = await requireHomeFeed(page, stats, result);
    if (heldAfterDwell === "blocked") break;
    if (heldAfterDwell === "left") {
      leftFeed = true;
      break;
    }

    if (chance(plan.idleChance)) await human.idle();
    if (loadedMore) {
      stats.stuck = 0;
      continue;
    }
    try {
      const scrolled = await human.scrollFeed({ reverseChance: plan.reverseScrollChance });
      const pace = endLoadingScreen(result, stats, scrolled);
      if (pace.stop) break;
      if (scrolled.empty) {
        const visible = scrolled.before?.visibleUpdates || scrolled.after?.visibleUpdates || 0;
        if (visible > 0) {
          log.info("Scroll reported an empty column but update nodes are still there. Not reloading.", { postsSeen: stats.postsSeen, visibleUpdates: visible });
          continue;
        }
        const maxTop = scrolled.before?.maxTop ?? scrolled.after?.maxTop;
        const top = scrolled.before?.top ?? scrolled.after?.top;
        if (Number.isFinite(maxTop) && maxTop <= COLLAPSED_MAX) {
          log.warn("Feed scroller has no travel. Not scrolling it.", { maxTop, top, postsSeen: stats.postsSeen, url: safePageUrl(page) });
          const loaded = await loadRealFeed(page, stats).catch(() => false);
          if (loaded || (stats.connectionClosed && stats.postsSeen > 0)) {
            if (!loaded) log.warn("Connection dropped during a feed reload. Posts were already on screen, so the planned scroll continues.", { postsSeen: stats.postsSeen });
            stats.stuck = 0;
            continue;
          }
          break;
        }
        const refreshed = await refreshEmptyFeed(page, stats, { visibleUpdates: visible });
        if (refreshed) {
          stats.stuck = 0;
          continue;
        }
        if (stats.connectionClosed && stats.postsSeen > 0) {
          log.warn("Connection dropped during a feed reload. Posts were already on screen, so the planned scroll continues.", { postsSeen: stats.postsSeen });
          await sleepJitter(1500, 3000);
          stats.stuck = 0;
          continue;
        }
        log.info("No visible posts after a refresh. Not scrolling.");
        break;
      }
      if (pace.held || scrolled.healed || scrolled.held) {
        stats.stuck = 0;
        continue;
      }
      const atBottom = Number.isFinite(scrolled?.after?.top) && Number.isFinite(scrolled?.after?.maxTop)
        && scrolled.after.top >= scrolled.after.maxTop - 8;
      if (scrolled.moved !== null && Math.abs(scrolled.moved) < 8) {
        stats.stuck += 1;
        log.warn("Scroll did not move the feed.", scrolled);
        if (await refreshStaleFeed(page, human, stats)) continue;
        if (atBottom) {
          const backed = await human.scrollFeed({ forceReverse: true });
          const reversePace = endLoadingScreen(result, stats, backed);
          if (reversePace.stop) break;
          if (reversePace.held) continue;
          if (backed.moved !== null && Math.abs(backed.moved) < 8) {
            log.warn("Reverse scroll also failed at the bottom of the feed.", backed);
          }
        }
      } else if (scrolled.moved !== null) {
        stats.stuck = 0;
      }
    } catch (error) {
      rethrowInfrastructure(error);
      // Recoverable pointer stalls must not abort; count them as dead scrolls so a
      // wedged feed cannot burn the full session timer without advancing.
      stats.stuck += 1;
      log.warn("Scroll gesture failed, continuing browse.", { message: error.message, stuck: stats.stuck });
    }
  }

  if (result.pageLost) {
    log.info("Skipping the wind-down: the feed tab is gone.", { postsSeen: stats.postsSeen });
  } else if (leftFeed) {
    result.reason = "Could not return to /feed/; feed step ended early";
    log.warn("Feed step ended early off the feed; later steps still run.", { url: page.url(), postsSeen: stats.postsSeen });
  } else if (!result.aborted) {
    log.info("Wind-down. No more likes. Leaving the feed as a person would.");
    try {
      const column = await readFeedColumn(page).catch(() => null);
      if (column && (column.visibleUpdates || 0) === 0) {
        log.info("Wind-down skipped scrolling because the feed has no visible posts.");
      } else {
        const wind = await human.scrollFeed({ reverseChance: 0.03 });
        endLoadingScreen(result, stats, wind);
      }
      if (!result.aborted) {
        await sleepJitter(1200, 2800);
        await human.idle();
      }
    } catch (error) {
      log.warn("Wind-down gesture failed.", { message: error.message });
      if (isInfrastructureFailure(error)) {
        result.aborted = true;
        result.failureKind = "infra";
        result.reason = error.message;
      }
    }
  }

  if (optimizer.plan?.verify) {
    log.info("Verification checklist from the feed.", {
      followAttempts: stats.followAttempts,
      follows: stats.follows,
      followButtonsSeen: stats.followButtonsSeen || 0,
      followNote: stats.followAttempts ? null : (stats.followButtonsSeen ? "Follow buttons appeared but none passed the follow gate (warmup, spacing, wind-down)" : "No Recommended-for-you or Suggested Follow button was on screen; Follow skipped"),
      feedVisits: stats.visits,
      companyVisits: stats.companyVisits || 0,
    });
  }
  result.companyVisits = stats.companyVisits || 0;
  result.profileConnections = stats.profileConnections || 0;
  result.profileConnectAttempts = stats.profileConnectAttempts || 0;
  result.profileSent = stats.profileSent || [];
  result.likes = stats.likes;
  result.follows = stats.follows;
  result.followAttempts = stats.followAttempts;
  result.visits = stats.visits;
  result.postDwells = stats.postDwells;
  result.videosWatched = stats.videosWatched;
  result.postsSeen = stats.postsSeen;
  result.expanded = stats.expanded;
  result.seeNewPosts = stats.seeNewPosts;
  result.durationMs = Date.now() - started;
  reportProgress();
  // New/short feeds (esp. cloud/local test profiles) may only expose a handful of
  // updates. Browse-only test runs only need proof the collector found real posts.
  if (shouldAbortFewPosts({
    aborted: result.aborted,
    postsSeen: result.postsSeen,
    testRun: plan.testRun,
    connectionClosed: stats.connectionClosed,
  })) {
    result.aborted = true;
    result.reason = "Too few distinct posts to verify useful feed browsing";
    if (feedLoadTrouble(stats)) {
      result.failureKind = "infra";
      log.warn("Few posts came from a feed that never finished loading. Counting it as infrastructure, not an account failure.", {
        postsSeen: result.postsSeen, loadingPasses: stats.loadingPasses || 0, shortColumn: Boolean(stats.shortColumnSeen),
        stalled: Boolean(stats.feedStalled), connectionClosed: Boolean(stats.connectionClosed),
      });
    }
  } else if (!result.aborted && result.postsSeen < 5 && plan.testRun && result.postsSeen > 0) {
    log.info("Browse-only test saw a short feed; accepting postsSeen below production bar.", { postsSeen: result.postsSeen });
  } else if (!result.aborted && result.postsSeen < 5 && stats.connectionClosed) {
    log.warn("A feed reload dropped the connection after posts were already on screen. Not marking the session as too few posts.", { postsSeen: result.postsSeen });
  }
  return result;
}

// The working tab is always a LinkedIn tab. A start tab (fingerprint checker, Gmail, a
// Chrome error page) is never foregrounded or given input; it is only pointed at LinkedIn,
// at most START_TAB_LINKEDIN_LOADS times. Never finding LinkedIn is a proxy/browser failure.
export const START_TAB_LINKEDIN_LOADS = 2;

function hostOf(href) {
  try { return new URL(href).hostname.toLowerCase(); } catch { return ""; }
}

function isLinkedInHref(href) {
  return ["www.linkedin.com", "linkedin.com"].includes(hostOf(href));
}

export async function getWorkingPage(browser, { preferGrow = false, attempts = 40, pause = sleepJitter } = {}) {
  let lastError;
  let startTabLoads = 0;
  let lastOffsite = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const pages = await browser.pages();
      const usable = pages.filter((page) => {
        try {
          const href = page.url();
          return Boolean(href) && href !== ":" && href !== "about:blank";
        } catch { return false; }
      });
      if (!usable.length) throw new Error("Profile opened with no tabs. Refusing to create a new page.");
      if (!usable.some((page) => { try { return isLinkedInHref(page.url()); } catch { return false; } })) {
        const start = usable.find((page) => isChromeErrorUrl(safePageUrl(page))) || usable[0];
        lastOffsite = safePageUrl(start);
        if (startTabLoads < START_TAB_LINKEDIN_LOADS && typeof start.goto === "function") {
          startTabLoads += 1;
          const target = isGmailOrBing(lastOffsite) ? "https://www.linkedin.com/" : FEED_URL;
          log.info("No LinkedIn tab yet. Pointing the start tab at LinkedIn without giving it any other input.", { from: lastOffsite, to: target, load: startTabLoads });
          try {
            await start.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
          } catch (error) {
            log.warn("Start tab did not load LinkedIn.", { message: error.message, url: safePageUrl(start) });
          }
          continue;
        }
        throw new Error(`Working tab is not LinkedIn yet (${lastOffsite})`);
      }
      const page = await pickLinkedInTab(usable, preferGrow);
      if (startTabLoads) log.info("LinkedIn is open. Session check decides whether warm-up continues.", { url: safePageUrl(page) });
      return page;
    } catch (error) {
      lastError = error;
      log.warn("Working tab not ready yet.", { attempt, message: error.message });
      if (attempt < attempts) await pause(1200, 2200);
    }
  }
  if (lastError && /Working tab is not LinkedIn|no tabs/i.test(lastError.message)) {
    throw infrastructureError(`${lastError.message}. No LinkedIn tab after ${startTabLoads} LinkedIn load(s) of the start tab; proxy or browser startup failed and the LinkedIn account was not paused.`, lastError);
  }
  throw lastError || new Error("Profile opened with no usable tabs.");
}

async function pickLinkedInTab(usable, preferGrow) {
  const pathOf = (page) => { try { return new URL(page.url()).pathname; } catch { return ""; } };
  const linkedInTabs = usable.filter((page) => { try { return isLinkedInHref(page.url()); } catch { return false; } });
  const grow = linkedInTabs.find((page) => /^\/mynetwork\/grow(?:\/|$)/.test(pathOf(page)));
  const network = linkedInTabs.find((page) => /^\/mynetwork(?:\/|$)/.test(pathOf(page)));
  const feed = linkedInTabs.find((page) => { try { return isOnHomeFeed(page.url()); } catch { return false; } });
  const page = (preferGrow && (grow || network)) || (!preferGrow && feed) || grow || network || feed || linkedInTabs[0];
  markRestoredTabs(usable, page);
  await foregroundPage(page, { timeoutMs: 6_000 });
  const href = await Promise.race([
    Promise.resolve().then(() => page.url()),
    new Promise((_, reject) => setTimeout(() => reject(new Error("page.url timed out")), 5_000)),
  ]);
  if (!isLinkedInHref(href)) throw new Error(`Working tab is not LinkedIn yet (${href})`);
  return page;
}
