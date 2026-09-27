import { randomFloat, randomInt, sleep } from "../util/random.js";
import { createLogger } from "../logger.js";
import { pagePointer } from "./trackpad.js";

const log = createLogger("press");

// Short on purpose: Orbita has stalled CDP input during Grow. A stalled command is
// abandoned, never re-sent.
export const PRESS_TIMEOUT_MS = 2_500;

function bezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u ** 3 * p0 + 3 * u ** 2 * t * p1 + 3 * u * t ** 2 * p2 + t ** 3 * p3;
}

export function curvePath(from, to, steps = randomInt(14, 28)) {
  const cp1 = { x: from.x + (to.x - from.x) * randomFloat(0.18, 0.42) + randomFloat(-22, 22), y: from.y + (to.y - from.y) * randomFloat(0.08, 0.38) + randomFloat(-26, 26) };
  const cp2 = { x: from.x + (to.x - from.x) * randomFloat(0.55, 0.82) + randomFloat(-16, 16), y: from.y + (to.y - from.y) * randomFloat(0.52, 0.88) + randomFloat(-20, 20) };
  const out = [];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    out.push({ x: bezier(t, from.x, cp1.x, cp2.x, to.x), y: bezier(t, from.y, cp1.y, cp2.y, to.y) });
  }
  out.push({ x: to.x, y: to.y });
  return out;
}

// Pages without CDP (test fixtures) go through page.mouse; there the press and release are
// one page.mouse.click.
function channel(page, timeoutMs) {
  if (typeof page.createCDPSession === "function") {
    const pointer = pagePointer(page);
    const send = (params) => pointer.dispatch({ modifiers: 0, pointerType: "mouse", ...params }, timeoutMs);
    return {
      at: () => ({ x: pointer.x, y: pointer.y }),
      move: async (x, y) => { pointer.x = x; pointer.y = y; await send({ type: "mouseMoved", x, y, buttons: 0 }); },
      press: (x, y) => send({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }),
      release: (x, y) => send({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }),
      combined: false,
    };
  }
  let last = { x: 0, y: 0 };
  return {
    at: () => last,
    move: async (x, y) => { last = { x, y }; await page.mouse.move(x, y); },
    press: (x, y, holdMs) => page.mouse.click(x, y, { delay: holdMs }),
    release: async () => {},
    combined: true,
  };
}

// One curved move onto `target`, a hit check, `beforePress` (the reservation point; falsy
// cancels), then exactly one mousePressed. A press that times out or errors is never sent
// again; `pressUncertain` tells the caller to read the page to learn whether it landed.
export async function curvedPress(page, target, { probe, beforePress = () => true, pause = sleep, signal, timeoutMs = PRESS_TIMEOUT_MS } = {}) {
  signal?.throwIfAborted();
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return { pressed: false, why: "locate-miss" };
  const io = channel(page, timeoutMs);
  const start = io.at();
  const from = start.x || start.y ? start : { x: target.x + randomFloat(-180, 180), y: target.y + randomFloat(60, 220) };
  const end = { x: target.x + randomFloat(-1.5, 1.5), y: target.y + randomFloat(-1.5, 1.5) };
  try {
    for (const step of curvePath(from, end)) {
      await io.move(step.x, step.y);
      await pause(randomInt(5, 16));
    }
  } catch (error) {
    if (io.combined) throw error;
    log.warn("Pointer move stalled before the press; not pressing.", { message: error.message });
    return { pressed: false, why: "move-timeout" };
  }
  await pause(randomInt(350, 900));
  signal?.throwIfAborted();
  if (!(await probe({ x: end.x, y: end.y }))) return { pressed: false, why: "hit-miss" };
  const token = beforePress();
  if (!token) return { pressed: false, why: "not-reserved" };
  const holdMs = randomInt(60, 140);
  if (io.combined) {
    await io.press(end.x, end.y, holdMs);
    return { pressed: true, token };
  }
  let pressError = null;
  try { await io.press(end.x, end.y); } catch (error) { pressError = error; }
  await pause(holdMs);
  // The release goes out even after a stalled press so a delivered press is not left held.
  try { await io.release(end.x, end.y); } catch { /* the press outcome is read from the page */ }
  if (pressError) {
    log.warn("Press did not acknowledge; it is not sent again.", { message: pressError.message });
    return { pressed: false, pressUncertain: true, why: "press-timeout", token };
  }
  return { pressed: true, token };
}
