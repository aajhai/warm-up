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

export class TrustedPointer {
  constructor(page, { commandTimeoutMs = POINTER_COMMAND_TIMEOUT_MS } = {}) {
    this.page = page;
    this.cdp = null;
    this.dead = false;
    this.x = 0;
    this.y = 0;
    this.strikes = 0;
    this.commandTimeoutMs = commandTimeoutMs;
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
    const ephemeral = this.dead || this.strikes >= 2;
    let session;
    try {
      session = ephemeral
        ? await raceTimeout(this.page.createCDPSession(), timeoutMs, "CDP mouse session attach timed out")
        : await raceTimeout(this.attach(), timeoutMs, "CDP mouse session attach timed out");
    } catch (error) {
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
      this.strikes += 1;
      log.warn("Pointer CDP command stalled; abandoning that session instead of waiting for protocolTimeout.", {
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
    } catch {
      await this.dispatch(params);
    }
  }

  async move(x, y) {
    this.x = x;
    this.y = y;
    const { x: px, y: py } = this.coords();
    try {
      await this.sendWithRetry({
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

  async click() {
    const { x, y } = this.coords();
    await this.sendWithRetry({
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
      pointerType: "mouse",
    });
    await sleep(randomInt(42, 130));
    try {
      await this.sendWithRetry({
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
        pointerType: "mouse",
      });
    } catch {
      // Press already went out; do not hang the session on a stuck release.
    }
  }
}
