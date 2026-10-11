import { randomFloat, randomInt, sleep } from "../util/random.js";
import { createLogger } from "../logger.js";

const log = createLogger("pointer");
export const POINTER_COMMAND_TIMEOUT_MS = 3500;

export function trackpadDeltas(distancePx) {
  const sign = distancePx < 0 ? -1 : 1;
  let remaining = Math.abs(distancePx);
  let speed = randomFloat(5, 12);
  const peak = randomFloat(26, 48);
  const accel = randomFloat(1.07, 1.13);
  const deltas = [];
  let phase = "accel";

  while (remaining > 2.5 && deltas.length < 90) {
    const step = Math.min(remaining, speed + randomFloat(-1.4, 1.8));
    deltas.push(sign * step);
    remaining -= Math.abs(step);
    if (phase === "accel") {
      speed = Math.min(peak, speed * accel + randomFloat(0, 1.5));
      if (speed > peak * 0.9) phase = "coast";
    } else if (phase === "coast") {
      speed += randomFloat(-1.8, 1.8);
      if (speed > peak) speed = peak;
      if (Math.random() < 0.2) phase = "decay";
    } else {
      speed *= randomFloat(0.82, 0.92);
      if (speed < 2.8) speed = 2.8;
    }
  }
  return deltas;
}

export function gestureGapMs() {
  return randomInt(7, 18);
}

function raceTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function isClosedTargetError(error) {
  return /Target closed|Session closed\. Most likely the page has been closed|No target with given id/i.test(error?.message || "");
}

const pagePointers = new WeakMap();

// One pointer per tab, so a Grow or profile click starts where the feed pointer stopped.
export function pagePointer(page) {
  let pointer = pagePointers.get(page);
  if (!pointer) {
    pointer = new TrustedPointer(page);
    pagePointers.set(page, pointer);
  }
  return pointer;
}

// On a slow Orbita/proxy profile a burst of tiny mouse moves outruns the input pipeline and
// each move waits out the command timeout. After a stall the pointer slows down for a while:
// moves are not re-sent, and moves closer together than the slow gap are skipped (the
// coordinates still track). Presses, releases, and wheels are always sent.
export const POINTER_SLOW_MODE_MS = 60_000;
export const POINTER_SLOW_MOVE_GAP_MS = 120;

export class TrustedPointer {
  constructor(page, { commandTimeoutMs = POINTER_COMMAND_TIMEOUT_MS, now = Date.now } = {}) {
    this.page = page;
    this.cdp = null;
    this.dead = false;
    this.x = 0;
    this.y = 0;
    this.strikes = 0;
    this.commandTimeoutMs = commandTimeoutMs;
    this.now = now;
    this.slowUntil = 0;
    this.stalls = 0;
    this.lastMoveAt = 0;
  }

  slowed() {
    return this.now() < this.slowUntil;
  }

  noteStall() {
    this.stalls += 1;
    if (!this.slowed()) log.warn("Pointer input is stalling on this profile. Slowing the pointer cadence.", { stalls: this.stalls, slowForSec: POINTER_SLOW_MODE_MS / 1000 });
    this.slowUntil = this.now() + POINTER_SLOW_MODE_MS;
  }

  coords() {
    return { x: Number(this.x.toFixed(1)), y: Number(this.y.toFixed(1)) };
  }

  async attach() {
    if (this.dead || this.cdp) return this.cdp;
    this.cdp = await this.page.createCDPSession();
    return this.cdp;
  }

  markDead() {
    this.dead = true;
    const session = this.cdp;
    this.cdp = null;
    session?.detach().catch(() => {});
  }

  async drop(session) {
    if (!session) return;
    if (session === this.cdp) this.cdp = null;
    await session.detach().catch(() => {});
  }

  async recover() {
    await this.page.bringToFront?.().catch(() => {});
  }

  async dispatch(params, timeoutMs = this.commandTimeoutMs) {
    if (this.closed) throw new Error("Target closed: pointer page target is gone");
    const ephemeral = this.dead || this.strikes >= 2;
    let session;
    try {
      session = ephemeral
        ? await raceTimeout(this.page.createCDPSession(), timeoutMs, "CDP mouse session attach timed out")
        : await raceTimeout(this.attach(), timeoutMs, "CDP mouse session attach timed out");
    } catch (error) {
      if (isClosedTargetError(error)) {
        this.closed = true;
        throw error;
      }
      this.strikes += 1;
      if (this.strikes >= 2) this.markDead();
      await this.recover();
      throw error;
    }
    try {
      await raceTimeout(
        session.send("Input.dispatchMouseEvent", params),
        timeoutMs,
        "CDP mouse event timed out",
      );
      this.strikes = 0;
    } catch (error) {
      if (isClosedTargetError(error)) {
        // The tab's target is already gone. That is not a stall, and bringing a dead
        // tab forward or re-sending cannot help; the caller re-resolves the live page.
        this.closed = true;
        log.warn("Pointer target closed under the input session; the page must be re-resolved.", { message: error.message });
        await this.drop(session);
        throw error;
      }
      this.strikes += 1;
      this.noteStall();
      log.warn("Pointer CDP command stalled; dropping that CDP input session instead of waiting for protocolTimeout.", {
        message: error.message,
        strikes: this.strikes,
      });
      await this.drop(session);
      if (this.strikes >= 2) this.markDead();
      await this.recover();
      throw error;
    } finally {
      if (ephemeral) await this.drop(session);
    }
  }

  async sendWithRetry(params) {
    try {
      await this.dispatch(params);
    } catch (error) {
      if (isClosedTargetError(error)) throw error;
      await this.dispatch(params);
    }
  }

  async move(x, y) {
    this.x = x;
    this.y = y;
    const slow = this.slowed();
    if (slow && this.now() - this.lastMoveAt < POINTER_SLOW_MOVE_GAP_MS) return;
    this.lastMoveAt = this.now();
    const { x: px, y: py } = this.coords();
    try {
      await (slow ? this.dispatch.bind(this) : this.sendWithRetry.bind(this))({
        type: "mouseMoved",
        x: px,
        y: py,
        modifiers: 0,
        buttons: 0,
        pointerType: "mouse",
      });
    } catch {
      // Coordinates stay in sync even if Orbita dropped the gesture.
    }
  }

  async wheel(deltaY) {
    const { x, y } = this.coords();
    await this.sendWithRetry({
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      modifiers: 0,
      pointerType: "mouse",
    });
  }

  async click({ holdMs, singlePress = false } = {}) {
    const { x, y } = this.coords();
    const press = { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0, pointerType: "mouse" };
    const release = { ...press, type: "mouseReleased", buttons: 0 };
    // A timed-out press may still have reached Orbita. With singlePress it is
    // never re-sent; the release still goes out so the button is not left held,
    // and the caller learns the outcome is uncertain.
    let pressError = null;
    if (singlePress) {
      try { await this.dispatch(press); } catch (error) { pressError = error; }
    } else {
      await this.sendWithRetry(press);
    }
    // LinkedIn treats a slow press/release as a long-press and opens the reaction picker.
    const hold = Number.isFinite(holdMs) ? holdMs : randomInt(42, 130);
    await sleep(Math.max(12, hold));
    try {
      if (singlePress) await this.dispatch(release);
      else await this.sendWithRetry(release);
    } catch {
      // Press already went out; do not hang the session on a stuck release.
    }
    if (pressError) throw pressError;
  }
}
