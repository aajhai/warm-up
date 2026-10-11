import { alignControl, collectPosts, feedWheelAnchor, healFeedColumn, locateControl, pointerBounds, probePoint, likeActionBand, readFeedColumn, readFeedLoadSnapshot } from "../scenario/linkedinDom.js";
import { scrollHoldReason } from "../scenario/linkedinFeed.js";
import { createLogger } from "../logger.js";
import { randomFloat, randomInt, sleep, sleepJitter } from "../util/random.js";
import { pagePointer, trackpadDeltas } from "./trackpad.js";

const log = createLogger("human");

const FEED_HOLD_WAITS = 4;
const FEED_HOLD_MIN_MS = 1200;
const FEED_HOLD_MAX_MS = 2500;

function paintDetails(snapshot) {
  return {
    readyState: snapshot?.readyState || "",
    pendingImages: snapshot?.pendingImages || 0,
    skeletons: snapshot?.skeletons || 0,
    feedHeight: snapshot?.feedHeight || 0,
    railText: snapshot?.railText || 0,
    railControls: snapshot?.railControls || 0,
  };
}

// Sample, wait like a person, sample again. At most four waits. Still loading means do not wheel.
async function awaitFeedPaint(page, pause) {
  let previous = null;
  let snapshot = null;
  let reason = null;
  for (let sample = 0; sample <= FEED_HOLD_WAITS; sample += 1) {
    snapshot = await readFeedLoadSnapshot(page);
    reason = scrollHoldReason(snapshot, previous);
    if (!reason) return { stillLoading: false, reason: null, snapshot };
    if (sample === FEED_HOLD_WAITS) break;
    log.info("Feed is still loading. Waiting before scrolling.", { reason, wait: sample + 1, ...paintDetails(snapshot) });
    previous = snapshot;
    await pause(FEED_HOLD_MIN_MS, FEED_HOLD_MAX_MS);
  }
  log.info("Feed is still loading. Not scrolling this pass.", { reason, ...paintDetails(snapshot) });
  return { stillLoading: true, reason, snapshot };
}

function bezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u ** 3 * p0 + 3 * u ** 2 * t * p1 + 3 * u * t ** 2 * p2 + t ** 3 * p3;
}

export function controlNeedsFeedClamp(kind) {
  return kind !== "like" && kind !== "more" && kind !== "see-new" && kind !== "home" && kind !== "follow" && kind !== "thin-follow" && kind !== "visit" && kind !== "mute";
}

export class HumanController {
  constructor(page) {
    this.page = page;
    this.pointer = pagePointer(page);
    this.lastWasReverse = false;
    this.primed = false;
    this.postsCache = [];
    this.postsCacheAt = 0;
    this.boundsCache = null;
    this.boundsAt = 0;
  }

  get x() {
    return this.pointer.x;
  }

  get y() {
    return this.pointer.y;
  }

  async clampToFeed(x, y) {
    try {
      if (!this.boundsCache || Date.now() - this.boundsAt > 800) {
        this.boundsCache = await pointerBounds(this.page);
        this.boundsAt = Date.now();
      }
      const bounds = this.boundsCache;
      if (!bounds || bounds.maxX <= bounds.minX) return { x, y };
      return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, x)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, y)),
      };
    } catch {
      return { x, y };
    }
  }

  async moveTo(x, y, { force = false, constrainToFeed = true } = {}) {
    const constrain = constrainToFeed ? (px, py) => this.clampToFeed(px, py) : async (px, py) => ({ x: px, y: py });
    const dest = await constrain(x, y);
    x = dest.x;
    y = dest.y;
    if (this.pointer.dead) {
      await this.pointer.move(x, y);
      this.primed = true;
      return;
    }
    const startX = this.pointer.x || x;
    const startY = this.pointer.y || y;
    const dist = Math.hypot(x - startX, y - startY);
    if (!force && this.primed && dist < 3) {
      await this.pointer.move(x, y);
      return;
    }
    const fullSteps = Math.max(12, Math.min(48, Math.round(Math.max(dist, 30) / 12)));
    const steps = this.pointer.slowed?.() ? Math.min(fullSteps, 6) : fullSteps;
    const cp1x = startX + (x - startX) * randomFloat(0.18, 0.42) + randomFloat(-18, 18);
    const cp1y = startY + (y - startY) * randomFloat(0.08, 0.38) + randomFloat(-24, 24);
    const cp2x = startX + (x - startX) * randomFloat(0.55, 0.82) + randomFloat(-16, 16);
    const cp2y = startY + (y - startY) * randomFloat(0.52, 0.88) + randomFloat(-20, 20);
    const overshootX = x + randomFloat(-4, 4);
    const overshootY = y + randomFloat(-4, 4);

    for (let i = 1; i <= steps; i += 1) {
      if (this.pointer.dead) { await this.pointer.move(x, y); break; }
      const t = i / steps;
      const point = await constrain(
        bezier(t, startX, cp1x, cp2x, overshootX),
        bezier(t, startY, cp1y, cp2y, overshootY),
      );
      await this.pointer.move(point.x, point.y);
      await sleep(randomInt(4, 14));
    }
    await this.pointer.move(x, y);
    this.primed = true;
  }

  async driftTo(x, y) {
    const dest = await this.clampToFeed(x, y);
    if (this.pointer.dead) { await this.pointer.move(dest.x, dest.y); return; }
    const steps = randomInt(4, 9);
    for (let i = 1; i <= steps; i += 1) {
      if (this.pointer.dead) { await this.pointer.move(dest.x, dest.y); break; }
      const t = i / steps;
      const point = await this.clampToFeed(
        this.pointer.x + (dest.x - this.pointer.x) * t + randomFloat(-2.2, 2.2),
        this.pointer.y + (dest.y - this.pointer.y) * t + randomFloat(-2.2, 2.2),
      );
      await this.pointer.move(point.x, point.y);
      await sleep(randomInt(6, 16));
    }
    this.primed = true;
  }

  async revealControl(urn, kind, { locate = locateControl } = {}) {
    await this.ensureOverFeed();
    if (kind === "like") {
      try {
        await alignControl(this.page, urn, kind);
        await sleep(160);
      } catch {
        /* tests and mid-navigation skip native alignment */
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const point = await locate(this.page, urn, kind);
      if (!point) return null;
      let vh = 900;
      try { vh = await this.page.evaluate(() => window.innerHeight); }
      catch { /* use fallback viewport if the tab is mid-navigation */ }
      const band = kind === "like"
        ? likeActionBand(vh)
        : { minY: 150, maxY: Math.max(230, (Number(vh) || 900) - 130) };
      if (point.y >= band.minY && point.y <= band.maxY) return point;
      try {
        await this.pointer.wheel(point.y - (band.minY + band.maxY) / 2);
      } catch (error) {
        log.warn("Could not scroll a control into the action band.", { kind, message: error.message });
        return point;
      }
      await sleep(180);
      this.postsCacheAt = 0;
      this.boundsCache = null;
    }
    return locate(this.page, urn, kind);
  }

  async clickAt(x, y, kind, urn, { shortPress = false, singlePress = false } = {}) {
    try {
      await this.moveTo(x + randomFloat(-1.2, 1.2), y + randomFloat(-1.2, 1.2), { constrainToFeed: controlNeedsFeedClamp(kind) });
      // Hover dwell on Like opens LinkedIn's reaction flyout; keep likes snappy.
      const dwell = kind === "like" || shortPress ? randomInt(20, 55) : randomInt(70, 220);
      await sleep(dwell);
      const hit = await probePoint(this.page, this.pointer.x, this.pointer.y, kind, urn);
      if (!hit?.safe) {
        log.warn("Refusing click. Pointer is not on a safe control.", {
          kind,
          x: this.pointer.x,
          y: this.pointer.y,
          reason: hit?.reason,
          href: hit?.href,
          label: hit?.label,
        });
        return false;
      }
      await this.pointer.click({
        holdMs: kind === "like" || shortPress ? randomInt(18, 45) : undefined,
        singlePress,
      });
      return true;
    } catch (error) {
      log.warn("Click failed.", { kind, message: error.message });
      return false;
    }
  }

  async livePosts() {
    if (Date.now() - this.postsCacheAt < 500 && this.postsCache.length) return this.postsCache;
    this.postsCache = await collectPosts(this.page);
    if (!this.postsCache.length) {
      this.postsCache = await collectPosts(this.page, { reveal: true });
    }
    this.postsCacheAt = Date.now();
    return this.postsCache;
  }

  async gazeTarget() {
    const posts = await this.livePosts();
    const hit = posts.find((post) => post.height > 60 && post.top > 70 && post.top < 640);
    if (!hit) return null;
    return {
      x: hit.midX,
      y: hit.midY,
      top: hit.top,
      height: hit.height,
    };
  }

  async scrollOffset() {
    const posts = await this.livePosts();
    const first = posts[0];
    // Measure main#workspace itself. elementFromPoint walks into document viewers
    // and carousels, which are not the feed scroller.
    const metrics = await this.page.evaluate(() => {
      const root = document.querySelector("main#workspace")
        || document.querySelector("main")
        || document.scrollingElement
        || document.documentElement;
      return {
        top: root.scrollTop || 0,
        maxTop: Math.max(0, (root.scrollHeight || 0) - (root.clientHeight || 0)),
        windowY: window.scrollY || 0,
        owner: root.id === "workspace"
          ? "main#workspace"
          : (root === document.scrollingElement ? "document" : root.tagName.toLowerCase()),
      };
    });
    return {
      ...metrics,
      firstTop: first ? Math.round(first.top) : null,
      firstUrn: first?.urn || null,
    };
  }

  async ensureOverFeed() {
    const posts = await this.livePosts();
    const post = posts[0];
    const box = post
      ? { x: post.midX - 80, y: post.top, width: 220, height: Math.max(post.height, 200) }
      : await this.page.evaluate(() => {
        const main = document.querySelector("main") || document.body;
        const r = main.getBoundingClientRect();
        return { x: r.x || window.innerWidth * 0.42, y: r.y || window.innerHeight * 0.38, width: Math.max(r.width, 200), height: Math.max(r.height, 200) };
      });
    const x = box.x + box.width * randomFloat(0.32, 0.58);
    const y = Math.min(Math.max(box.y + Math.min(box.height, 420) * randomFloat(0.18, 0.42), 140), 620);
    await this.moveTo(x, y, { force: !this.primed });
  }

  async followContent() {
    const target = await this.gazeTarget();
    if (!target) {
      await this.driftTo(this.pointer.x + randomFloat(-14, 16), this.pointer.y + randomFloat(-18, 20));
      return;
    }
    await this.driftTo(
      target.x + randomFloat(-10, 10),
      Math.min(640, Math.max(110, target.y + randomFloat(-8, 12))),
    );
  }

  async scrollFeed({ reverseChance = 0.05, forceReverse = false, pause = sleepJitter } = {}) {
    const livePage = typeof this.page.url === "function";
    if (livePage) {
      const column = await readFeedColumn(this.page);
      // Nothing on screen. Do not wheel a blank feed; the caller refreshes instead.
      if (column && (column.visibleUpdates || 0) === 0) {
        return { reverse: false, moved: 0, ticks: 0, before: column, after: column, fallback: false, empty: true };
      }
      const paint = await awaitFeedPaint(this.page, pause);
      if (paint.stillLoading) {
        const shot = paint.snapshot || column;
        return {
          held: true,
          stillLoading: true,
          reason: paint.reason,
          moved: 0,
          ticks: 0,
          before: shot,
          after: shot,
          fallback: false,
        };
      }
      const anchor = await feedWheelAnchor(this.page);
      if (anchor) await this.moveTo(anchor.x, anchor.y, { constrainToFeed: false });
      else await this.ensureOverFeed();
    } else {
      await this.ensureOverFeed();
      await this.followContent();
    }
    const before = await this.scrollOffset();
    let reverse = forceReverse || Math.random() < reverseChance;
    if (!forceReverse && reverse && this.lastWasReverse) reverse = false;
    if (!forceReverse && !reverse && before.maxTop > 200 && before.top >= before.maxTop - 8) reverse = true;
    this.lastWasReverse = reverse;
    const sign = reverse ? -1 : 1;
    // One short wheel. A 400–700px jump unmounts LinkedIn's lazy update list
    // before the next cards paint, which is the blank center column.
    const deltas = trackpadDeltas(sign * randomInt(140, 240));

    // Orbita becomes unreliable when one gesture is split into dozens of CDP
    // commands. Keep the pointer stationary and dispatch the full burst once.
    await this.pointer.wheel(deltas.reduce((sum, delta) => sum + delta, 0));

    // A CDP acknowledgement can precede the compositor update. Observe the page
    // for bounded time instead of sampling once and reporting a false no-op.
    let after = before;
    let moved = 0;
    let lastTop = before.top;
    let stableReads = 0;
    const deadline = Date.now() + 700;
    do {
      await sleep(80);
      this.postsCacheAt = 0;
      after = await this.scrollOffset();
      moved = scrollDistance(before, after);
      if (moved !== 0 && Math.abs(after.top - lastTop) < 2) stableReads += 1;
      else stableReads = 0;
      lastTop = after.top;
    } while ((moved === 0 || stableReads < 2) && Date.now() < deadline);

    let fallback = false;
    if (moved === 0 && typeof this.page.evaluate === "function") {
      // Cloud Orbita occasionally acknowledges Input.dispatchMouseEvent without
      // delivering the wheel. Use one bounded DOM scroll as a recovery gesture.
      await this.page.evaluate(({ deltaY }) => {
        const root = document.querySelector("main#workspace")
          || document.querySelector("main")
          || document.scrollingElement
          || document.documentElement;
        root.scrollTop += deltaY;
      }, { deltaY: deltas.reduce((sum, delta) => sum + delta, 0) });
      fallback = true;
      await sleep(120);
      this.postsCacheAt = 0;
      after = await this.scrollOffset();
      moved = scrollDistance(before, after);
    }
    if (livePage && moved !== 0) {
      const column = await readFeedColumn(this.page);
      if (column && !column.feedVisible) {
        const healed = await healFeedColumn(this.page);
        if (healed?.healed) {
          await sleep(320);
          return { reverse, moved, ticks: deltas.length, before, after: { ...after, ...healed }, fallback, healed: true };
        }
      }
    }
    return { reverse, moved, ticks: deltas.length, before, after, fallback };
  }

  async idle() {
    await this.ensureOverFeed();
    await this.followContent();
    await sleep(randomInt(500, 1800));
  }

  async readPause(textLen = 200, extraMs = 0) {
    const base = Math.min(4200, 500 + textLen * randomFloat(5, 11));
    const total = randomInt(Math.round(base * 0.65), Math.round(base * 1.2)) + extraMs;
    const slices = randomInt(2, 4);
    for (let i = 0; i < slices; i += 1) {
      await this.driftTo(this.pointer.x + randomFloat(-22, 24), this.pointer.y + randomFloat(-28, 32));
      await sleep(total / slices);
    }
  }

  async waitAfterExpand() {
    await this.followContent();
    await sleepJitter(1800, 4800);
  }
}

export function scrollDistance(before, after) {
  const windowDelta = Math.abs(after.top - before.top);
  if (windowDelta) return windowDelta;
  if (before.firstUrn && before.firstUrn === after.firstUrn) return Math.abs(after.firstTop - before.firstTop);
  // With different first cards there is no shared anchor to measure pixel displacement.
  if (before.firstUrn !== after.firstUrn) return null;
  return 0;
}
