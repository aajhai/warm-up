import { config } from "../config.js";
import { alreadyAttempted, finishAction, reserveAction, weeklyBudget } from "../activity.js";
import { inspectAccount } from "./accountGuard.js";
import { randomInt, sleep } from "../util/random.js";

export function networkDomWorld() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.top >= 60 && r.bottom < innerHeight && getComputedStyle(el).visibility !== "hidden";
  };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const connect = (el) => !el.disabled && (/^connect$/i.test(label(el)) || /^invite .+ to connect$/i.test(el.getAttribute("aria-label") || ""));
  const canonical = (href) => {
    try {
      const url = new URL(href, location.origin);
      if (!["www.linkedin.com", "linkedin.com"].includes(url.hostname) || !/^\/in\/[^/]+\/?$/.test(url.pathname)) return null;
      return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`;
    } catch { return null; }
  };
  function cardFor(button) {
    let el = button.parentElement;
    for (let depth = 0; el && depth < 7 && el.tagName !== "MAIN"; depth += 1, el = el.parentElement) {
      const links = [...el.querySelectorAll("a[href]")].map((link) => ({ url: canonical(link.href), name: (link.innerText || "").trim().split("\n")[0].trim() })).filter((link) => link.url);
      const targets = new Set(links.map((link) => link.url));
      if (targets.size !== 1) continue;
      if ([...el.querySelectorAll("button")].filter(connect).length > 1) return null;
      const person = links.find((link) => link.name && link.name.length < 120);
      if (person) return { el, ...person };
    }
    return null;
  }
  function candidates() {
    if (document.querySelector('[role="dialog"], dialog[open]')) return [];
    const root = document.querySelector("main");
    if (!root) return [];
    return [...root.querySelectorAll("button")].filter((b) => visible(b) && connect(b)).flatMap((button) => {
      const card = cardFor(button);
      return card ? [{ ...card, button }] : [];
    });
  }
  const point = (button) => { const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  function inspect() {
    return candidates().map(({ url, name }) => ({ url, name }));
  }
  function locate({ url }) {
    const match = candidates().find((c) => c.url === url);
    return match ? point(match.button) : null;
  }
  function probe({ url, x, y }) {
    const match = candidates().find((c) => c.url === url);
    const hit = document.elementFromPoint(x, y);
    return Boolean(match && hit && match.button.contains(hit));
  }
  function dialog({ name }) {
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter((el) => el.getBoundingClientRect().width > 0);
    if (!dialogs.length) return { open: false };
    if (dialogs.length !== 1) return { open: true, safe: false };
    const modal = dialogs[0];
    const text = (modal.innerText || "").toLowerCase();
    if (!name || !text.includes(name.toLowerCase()) || modal.querySelector('input[type="email"]')) return { open: true, safe: false };
    const buttons = [...modal.querySelectorAll("button")].filter((b) => visible(b) && !b.disabled && /^send without (?:a )?note$/i.test(label(b)));
    if (buttons.length !== 1) return { open: true, safe: false };
    return { open: true, safe: true, ...point(buttons[0]) };
  }
  function probeDialog({ name, x, y }) {
    const result = dialog({ name });
    if (!result.safe) return false;
    const button = document.elementFromPoint(x, y)?.closest("button");
    return Boolean(button && /^send without (?:a )?note$/i.test(label(button)) && button.closest('[role="dialog"], dialog[open]'));
  }
  function pending({ url }) {
    const root = document.querySelector("main");
    if (!root) return false;
    for (const button of root.querySelectorAll("button")) {
      if (!/^pending$/i.test(label(button))) continue;
      const card = cardFor(button);
      if (card?.url === url) return true;
    }
    return false;
  }
  return { inspect, locate, probe, dialog, probeDialog, pending };
}

export async function networkDom(page, method, arg = {}) {
  return page.evaluate((source, operation, input) => (0, eval)(`(${source})`)()[operation](input), networkDomWorld.toString(), method, arg);
}

async function checkedClick(page, candidate, kind, signal, pause, deadline) {
  signal?.throwIfAborted();
  const point = await networkDom(page, kind === "connect" ? "locate" : "dialog", candidate);
  if (!point || (kind !== "connect" && !point.safe)) return false;
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await pause(randomInt(180, 500));
  signal?.throwIfAborted();
  if (Date.now() >= deadline) return false;
  const safe = await networkDom(page, kind === "connect" ? "probe" : "probeDialog", { ...candidate, ...point });
  if (!safe) return false;
  await page.mouse.click(point.x, point.y, { delay: randomInt(60, 140) });
  return true;
}

export async function runConnectionBatch(page, state, { signal, maxDurationMs = 4 * 60_000, maxAttempts = Infinity, pause = sleep } = {}) {
  const result = { connections: 0, attempted: 0, accountBlock: null, reason: null };
  if (!config.connectionsEnabled || state.currentRun?.testRun || state.pause) return result;
  const budget = weeklyBudget(state);
  if (!budget.remaining) return { ...result, reason: "Weekly connection budget exhausted" };
  if (maxAttempts !== Infinity && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) throw new Error("Invalid connection trial limit");
  const max = Math.min(randomInt(...config.connectionBatchRange), budget.remaining, maxAttempts);
  const deadline = Date.now() + maxDurationMs;
  let block = await inspectAccount(page);
  if (block) return { ...result, accountBlock: block };
  await page.goto("https://www.linkedin.com/mynetwork/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await pause(randomInt(3000, 6000));
  let emptyPasses = 0;
  while (Date.now() < deadline && result.attempted < max) {
    signal?.throwIfAborted();
    block = await inspectAccount(page);
    if (block) return { ...result, accountBlock: block };
    const url = new URL(page.url());
    if (!["www.linkedin.com", "linkedin.com"].includes(url.hostname) || !/^\/mynetwork(?:\/|$)/.test(url.pathname)) return { ...result, reason: "Unexpected navigation in My Network", accountBlock: { kind: "unexpected_page", reason: "Review unexpected My Network navigation" } };
    const candidates = await networkDom(page, "inspect");
    const candidate = candidates.find((c) => !alreadyAttempted(state, "connect", c.url));
    if (!candidate) {
      emptyPasses += 1;
      if (emptyPasses >= 4) return { ...result, reason: "No unambiguous new connection suggestions found" };
      await page.mouse.wheel({ deltaY: randomInt(280, 520) });
      await pause(randomInt(2000, 4000));
      continue;
    }
    emptyPasses = 0;
    await pause(randomInt(2500, 5500));
    signal?.throwIfAborted();
    if (Date.now() >= deadline) break;
    block = await inspectAccount(page);
    if (block) return { ...result, accountBlock: block };
    const action = reserveAction(state, "connect", candidate.url, { limit: max });
    if (!action) break;
    result.attempted += 1;
    let confirmed = false;
    try {
      const clicked = await checkedClick(page, candidate, "connect", signal, pause, deadline);
      if (!clicked) {
        result.reason = "Connect control changed before clicking";
      } else {
        await pause(randomInt(1000, 1800));
        block = await inspectAccount(page);
        if (!block) {
          const dialog = await networkDom(page, "dialog", candidate);
          if (dialog.open) {
            if (!dialog.safe || !(await checkedClick(page, candidate, "send", signal, pause, deadline))) result.reason = "Connection dialog needs manual review";
          }
          for (let check = 0; check < 5 && !result.reason; check += 1) {
            signal?.throwIfAborted();
            block = await inspectAccount(page);
            if (block) break;
            if (await networkDom(page, "pending", candidate)) { confirmed = true; break; }
            await pause(700);
          }
        }
      }
    } catch (error) {
      result.reason = `Connection outcome uncertain: ${error.message}`;
    }
    finishAction(state, action, confirmed);
    if (confirmed) result.connections += 1;
    if (block) return { ...result, accountBlock: block };
    if (!confirmed) return { ...result, accountBlock: { kind: "uncertain_connection", reason: result.reason || "Connection was not confirmed as pending; inspect invitations before resuming" } };
    if (result.attempted >= max) break;
    // Brief pauses during the gap keep cancellation responsive, including after Mac sleep.
    const nextAt = Math.min(deadline, Date.now() + randomInt(25_000, 60_000));
    while (Date.now() < nextAt) { signal?.throwIfAborted(); await pause(Math.min(1000, nextAt - Date.now())); }
  }
  return result;
}
