import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { HumanController } from "../human/input.js";
import { createLogger } from "../logger.js";
import { chance, randomInt, sleepJitter } from "../util/random.js";
import { inspectAccount } from "./accountGuard.js";
import { foregroundPage } from "../browser/page.js";
import { isInfrastructureFailure } from "../util/failures.js";
import { alreadyVisited, rememberVisit } from "../activity.js";
import { profileConnect, readProfilePage, returnFrom, verifyNeeds, visitCompanyFromProfile } from "./linkedinProfile.js";
import { loadSharedDay } from "../inviteHold.js";
import {
  collectPosts,
  dialogOpen,
  dismissBlockingModals,
  dumpFeedDom,
  findFollowCandidates,
  findVisitTargets,
  locateVisit,
  findSeeNewPosts,
  followState,
  locateFollow,
  healFeedColumn,
  inspectFeed,
  readFeedColumn,
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

async function recoverHomeFeed(page) {
  const url = page.url();
  if (isOnHomeFeed(url) && !OFF_FEED_RE.test(url)) return true;
  log.warn("Left the home feed. Returning through the Home nav.", { url });
  await screenshot(page, "left-feed");
  // Browser Back is never used: from a chrome-error page it skips to the page before the
  // failed load (a profile). An error page is reloaded; otherwise Home is clicked, and the
  // feed URL is loaded only if that click does not land.
  if (/^chrome-error:/i.test(url) && typeof page.reload === "function") {
    try { await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }); } catch { /* checked below */ }
    await sleepJitter(1200, 2200);
    if (isOnHomeFeed(page.url())) return true;
  }
  const home = await homeNavPoint(page).catch(() => null);
  if (home) {
    try { await page.mouse.click(home.x, home.y, { delay: 80 }); }
    catch (error) { if (!/detached Frame|Execution context|navigation/i.test(error.message)) throw error; }
    await sleepJitter(1500, 2500);
    if (isOnHomeFeed(page.url())) return true;
  }
  if (typeof page.goto === "function") {
    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => log.warn("Feed load failed.", { message: error.message }));
    await sleepJitter(1200, 2200);
    if (isOnHomeFeed(page.url())) return true;
  }
  log.error("Could not return to /feed/. Ending the feed step so we do not browse another page.", { url: page.url() });
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

// Opens one post author (or, rarely, a "Recommended for you" person row), reads the page
// by scrolling only, and returns to the feed. Never the same URL twice for this account.
// Per-pass chance of a feed view. It rises through the session so planned views happen
// instead of lapsing when the early rolls miss.
export function feedVisitChance({ elapsedMs, windowMs, base = 0.07 }) {
  const progress = windowMs > 0 ? Math.min(1, Math.max(0, elapsedMs / windowMs)) : 1;
  return progress < 0.5 ? base : progress < 0.75 ? Math.max(base, 0.15) : Math.max(base, 0.3);
}

export async function maybeVisitFromFeed(page, human, optimizer, stats, { started, endsAt, signal, onHeartbeat = () => {}, read = readProfilePage, rng = Math.random, visitChance } = {}) {
  const plan = optimizer.plan;
  if (!plan || plan.testRun || (stats.feedVisits || 0) >= (plan.feedVisits || 0)) return { visited: false };
  if (Date.now() - started < plan.warmupMs || endsAt - Date.now() < plan.windDownMs + 60_000) return { visited: false };
  const windowStart = started + plan.warmupMs;
  const windowMs = Math.max(1, endsAt - plan.windDownMs - 60_000 - windowStart);
  const baseChance = visitChance ?? feedVisitChance({ elapsedMs: Date.now() - windowStart, windowMs });
  const chanceNow = plan.verify ? Math.max(baseChance, 0.5) : baseChance;
  if (rng() >= chanceNow) return { visited: false };
  const state = optimizer.state;
  const targets = (await findVisitTargets(page)).filter((t) => !alreadyVisited(state, t.url));
  if (!targets.length) return { visited: false };
  const posts = targets.filter((t) => t.source === "post");
  const modules = targets.filter((t) => t.source === "module");
  const rail = targets.filter((t) => t.source === "home");
  const companies = targets.filter((t) => t.kind === "company");
  const people = targets.filter((t) => t.kind === "person");
  const roll = rng();
  // A verification session takes the first company it sees, then prefers people.
  const needCompany = plan.verify && verifyNeeds(state).company;
  const verifyPool = !plan.verify ? null
    : needCompany && companies.length ? companies
      : !needCompany && people.length ? people : null;
  const pool = verifyPool || (rail.length && (roll < 0.25 || (!posts.length && !modules.length)) ? rail
    : modules.length && (!posts.length || roll < 0.45) ? modules
      : posts.length ? posts : rail);
  const target = pool[Math.floor(rng() * pool.length)];
  stats.feedVisits = (stats.feedVisits || 0) + 1;
  const point = await human.revealControl(target.url, "visit", { locate: locateVisit });
  if (!point) return { visited: false };
  rememberVisit(state, target.url);
  if (!(await human.clickAt(point.x, point.y, "visit", target.url, { singlePress: true }))) {
    log.info("Profile link hit check failed. Not clicking it again.", { url: target.url });
    return { visited: false };
  }
  const want = target.kind === "company" ? /^\/company\// : /^\/in\//;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && !want.test(feedPath(page.url()))) { onHeartbeat(); await sleepJitter(300, 500); }
  if (!want.test(feedPath(page.url()))) {
    // A click that went nowhere, or landed on the feed again, is simply no visit.
    if (!isOnHomeFeed(page.url())) await returnToFeed(page, human, onHeartbeat);
    return { visited: false };
  }
  const block = await detectBlock(page);
  if (block.blocked) return { visited: false, accountBlock: block };
  log.info("Reading a page opened from the feed.", { url: target.url, source: target.source, kind: target.kind });
  await read(page, { signal, onHeartbeat });
  if (target.kind === "company") {
    stats.companyVisits = (stats.companyVisits || 0) + 1;
    if (state.currentRun) (state.currentRun.verified ||= {}).company = target.url;
  }
  // Verification fallback when search did not supply them: one exact top-card Connect and
  // one company page taken from this person's profile.
  if (plan.verify && target.kind === "person") {
    const needs = verifyNeeds(state);
    if (needs.connect && plan.searchConnect) {
      let shared = null;
      try { shared = loadSharedDay(); } catch { /* per-profile hold still applies */ }
      const connect = await profileConnect(page, state, { url: target.url, signal, shared });
      stats.profileConnections = (stats.profileConnections || 0) + connect.connections;
      stats.profileConnectAttempts = (stats.profileConnectAttempts || 0) + connect.attempted;
      stats.profileSent = [...(stats.profileSent || []), ...(connect.sent || [])];
      if (connect.accountBlock) return { visited: true, url: target.url, source: target.source, accountBlock: connect.accountBlock };
    }
    if (needs.company) {
      const company = await visitCompanyFromProfile(page, state, { signal, onHeartbeat, read, rng });
      if (company.accountBlock) return { visited: true, url: target.url, source: target.source, accountBlock: company.accountBlock };
      if (company.visited) {
        stats.companyVisits = (stats.companyVisits || 0) + 1;
        stats.visits = (stats.visits || 0) + 1;
      }
    }
  }
  const returned = await returnToFeed(page, human, onHeartbeat);
  log.info("Finished a feed view.", { url: target.url, source: target.source, kind: target.kind, returned, at: page.url() });
  human.postsCacheAt = 0;
  human.boundsCache = null;
  return { visited: true, url: target.url, source: target.source, returned };
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

export async function runLinkedInFeed(page, plan, optimizer, { signal, onHeartbeat = () => {}, onProgress = () => {} } = {}) {
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
    seeNewMisses: 0,
    follows: 0,
    followAttempts: 0,
    recommendedFollows: 0,
    lastFollowAt: 0,
    feedVisits: 0,
    visits: 0,
  };
  const followConsidered = new Set();
  let leftFeed = false;
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
  const reportProgress = () => onProgress({
    likes: stats.likes,
    postsSeen: stats.postsSeen,
    expanded: stats.expanded,
    seeNewPosts: stats.seeNewPosts,
  });

  const opened = await openFeed(page, human);
  let block = { blocked: false };
  try {
    block = await detectBlock(page);
  } catch (error) {
    rethrowInfrastructure(error);
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
  reportProgress();
  await writeFeedDump(page, "feed-dom-found");
  log.info("Posts are in the DOM. Starting human scroll with pointer tracking.", { count: readyPosts.length, postsSeen: stats.postsSeen });
  try {
    const settled = await readFeedColumn(page);
    if (settled && !settled.feedVisible) {
      log.warn("Feed list is outside the viewport before browsing. Pulling it back.", settled);
      await healFeedColumn(page);
      await sleepJitter(400, 800);
    } else if (settled && settled.railText < 20) {
      log.info("Side rails are still empty. Waiting for them to paint before scrolling.", settled);
      await sleepJitter(700, 1200);
    }
  } catch (error) {
    rethrowInfrastructure(error);
    log.warn("Feed column check failed. Continuing.", { message: error.message });
  }
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
    rethrowInfrastructure(error);
    log.warn("Initial scroll failed. Continuing if the page is still alive.", { message: error.message });
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
      leftFeed = true;
      break;
    }

    let loadedMore = false;
    if (stats.stuck >= 2) {
      const refreshed = await refreshStaleFeed(page, human, stats);
      loadedMore = refreshed;
      if (!refreshed) {
        try {
          await human.scrollFeed({ forceReverse: true });
        } catch (error) {
          rethrowInfrastructure(error);
          log.warn("Unstick scroll failed, continuing browse.", { message: error.message });
        }
      }
    } else {
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
    reportProgress();

    if (stats.stuck >= 8) {
      if (await refreshStaleFeed(page, human, stats)) continue;
      try {
        const backed = await human.scrollFeed({ forceReverse: true });
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
        const expand = optimizer.gateExpand({ post: focus, stats });
        if (expand.allow) {
          try {
            didExpand = await expandPost(page, human, focus);
            if (didExpand) stats.expanded += 1;
            if (didExpand) reportProgress();
          } catch (error) {
            rethrowInfrastructure(error);
            log.warn("More expand failed, continuing browse.", { message: error.message });
          }
          if (!(await recoverHomeFeed(page))) {
            leftFeed = true;
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
      const visit = await maybeVisitFromFeed(page, human, optimizer, stats, { started, endsAt, signal, onHeartbeat });
      if (visit.visited) stats.visits += 1;
      if (visit.accountBlock) {
        log.error("Account check failed on a visited page. Stopping.", { reason: visit.accountBlock.reason });
        result.aborted = true;
        result.checkpoint = ["challenge", "restriction"].includes(visit.accountBlock.kind);
        result.accountBlock = visit.accountBlock;
        result.reason = visit.accountBlock.reason;
        break;
      }
    } catch (error) {
      rethrowInfrastructure(error);
      log.warn("Profile view from the feed failed, continuing browse.", { message: error.message });
    }
    if (!(await recoverHomeFeed(page))) {
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
      if (scrolled.healed || scrolled.held) {
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

  if (leftFeed) {
    result.reason = "Could not return to /feed/; feed step ended early";
    log.warn("Feed step ended early off the feed; later steps still run.", { url: page.url(), postsSeen: stats.postsSeen });
  } else if (!result.aborted) {
    log.info("Wind-down. No more likes. Leaving the feed as a person would.");
    try {
      await human.scrollFeed({ reverseChance: 0.03 });
      await sleepJitter(1200, 2800);
      await human.idle();
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
  result.postsSeen = stats.postsSeen;
  result.expanded = stats.expanded;
  result.seeNewPosts = stats.seeNewPosts;
  result.durationMs = Date.now() - started;
  reportProgress();
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

export async function getWorkingPage(browser, { preferGrow = false } = {}) {
  let lastError;
  let openedLinkedInFromWeb = false;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const pages = await browser.pages();
      const usable = pages.filter((page) => {
        try {
          const href = page.url();
          return Boolean(href) && href !== ":" && href !== "about:blank";
        } catch { return false; }
      });
      const grow = usable.find((page) => {
        try { return /^\/mynetwork\/grow(?:\/|$)/.test(new URL(page.url()).pathname); } catch { return false; }
      });
      const network = usable.find((page) => {
        try { return /^\/mynetwork(?:\/|$)/.test(new URL(page.url()).pathname); } catch { return false; }
      });
      const feed = usable.find((page) => {
        try { return isOnHomeFeed(page.url()); } catch { return false; }
      });
      const linkedin = usable.find((page) => {
        try { return ["www.linkedin.com", "linkedin.com"].includes(new URL(page.url()).hostname); }
        catch { return false; }
      });
      const page = (preferGrow && (grow || network)) || (!preferGrow && feed) || grow || network || feed || linkedin || usable[0];
      if (!page) throw new Error("Profile opened with no tabs. Refusing to create a new page.");
      await foregroundPage(page, { timeoutMs: 6_000 });
      const href = await Promise.race([
        Promise.resolve().then(() => page.url()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("page.url timed out")), 5_000)),
      ]);
      if (!href || href === ":" || href === "about:blank") throw new Error("Working tab has no URL yet.");
      let host = "";
      try { host = new URL(href).hostname; } catch { host = ""; }
      if (!["www.linkedin.com", "linkedin.com"].includes(host)) {
        if (!openedLinkedInFromWeb && isGmailOrBing(href) && typeof page.goto === "function") {
          openedLinkedInFromWeb = true;
          log.info("Open tab is Gmail or Bing. Opening LinkedIn to check whether this profile is logged in.", { from: href });
          await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
          continue;
        }
        const offsite = new Error(openedLinkedInFromWeb
          ? `Opened LinkedIn from Gmail or Bing, but the tab is still not LinkedIn (${href})`
          : `Working tab is not LinkedIn yet (${href})`);
        if (openedLinkedInFromWeb) {
          lastError = offsite;
          break;
        }
        throw offsite;
      }
      if (openedLinkedInFromWeb) log.info("LinkedIn is open. Session check decides whether warm-up continues.", { url: href });
      return page;
    } catch (error) {
      lastError = error;
      log.warn("Working tab not ready yet.", { attempt, message: error.message });
      await sleepJitter(1200, 2200);
    }
  }
  throw lastError || new Error("Profile opened with no usable tabs.");
}
