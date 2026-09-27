import { config, sampleGrowInvites } from "../config.js";
import { alreadyAttempted, alreadyVisited, finishAction, finishActionNotSent, rememberVisit, reserveAction, weeklyBudget } from "../activity.js";
import { inviteHoldReason, loadSharedDay, recordInviteLimit, recordStillOffered } from "../inviteHold.js";
import { saveState } from "../sessionState.js";
import { INVITE_LIMIT_RE, inspectAccount } from "./accountGuard.js";
import { readProfilePage, returnFrom } from "./linkedinProfile.js";
import { createLogger } from "../logger.js";
import { curvedPress } from "../human/press.js";
import { randomInt, sleep } from "../util/random.js";

const log = createLogger("network");

export function networkDomWorld() {
  const onscreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden";
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return onscreen(el) && r.top >= 40 && r.bottom > 80;
  };
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const controls = (root) => [...(root || document).querySelectorAll("button, [role='button']")];
  const connect = (el) => !el.disabled && (/^connect$/i.test(label(el)) || /^invite .+ to connect$/i.test(el.getAttribute("aria-label") || ""));
  const canonical = (href) => {
    try {
      const url = new URL(href, location.origin);
      if (!["www.linkedin.com", "linkedin.com"].includes(url.hostname)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "in" || !parts[1] || !/^[A-Za-z0-9_%.-]+$/.test(parts[1])) return null;
      return `https://www.linkedin.com/in/${decodeURIComponent(parts[1])}`;
    } catch { return null; }
  };
  const samePerson = (linkName, invited) => {
    const left = linkName.toLowerCase();
    const right = invited.toLowerCase();
    return left === right || left.startsWith(`${right} `);
  };
  const personName = (text) => (text || "").replace(/\s+/g, " ").trim().split(/\s+[•·|]\s+/)[0].trim();
  const queryAll = (root, selector) => {
    const out = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  };
  const inviteName = (button) => {
    let el = button;
    for (let i = 0; el && i < 6; i += 1, el = el.parentElement) {
      const match = (el.getAttribute("aria-label") || "").match(/^invite (.+) to connect$/i);
      if (match) return personName(match[1]);
    }
    return "";
  };
  function personCard(start, wantedUrl) {
    let el = start.parentElement;
    for (let depth = 0; el && depth < 40 && el.tagName !== "BODY"; depth += 1, el = el.parentElement) {
      const links = queryAll(el, "a[href]").map((link) => ({ url: canonical(link.getAttribute("href") || link.href), name: personName(link.innerText || link.textContent || "") })).filter((link) => link.url && link.name && link.name.length < 400);
      const targets = new Set(links.map((link) => link.url));
      const connectsHere = controls(el).filter(connect);
      if (wantedUrl) {
        const match = links.find((link) => link.url === wantedUrl);
        if (match && (targets.size === 1 || connectsHere.length === 1)) return { el, ...match };
        continue;
      }
      const invited = connect(start) ? inviteName(start) : "";
      if (invited) {
        const named = links.filter((link) => samePerson(link.name, invited));
        const urls = [...new Set(named.map((link) => link.url))];
        if (urls.length === 1) return { el, url: urls[0], name: invited };
        const nameEl = queryAll(el, "*")
          .filter((node) => {
            const text = personName(node.innerText || node.textContent || "");
            return text.length < 400 && samePerson(text, invited);
          })
          .sort((a, b) => (a.innerText || a.textContent || "").length - (b.innerText || b.textContent || "").length)[0];
        if (nameEl) {
          const inside = nameEl.closest?.("a[href]");
          const insideUrl = inside ? canonical(inside.getAttribute("href") || "") : null;
          if (insideUrl) return { el, url: insideUrl, name: invited };
          const before = queryAll(el, "a[href]").filter((anchor) => (anchor.compareDocumentPosition(nameEl) & 4) && canonical(anchor.getAttribute("href") || ""));
          const url = before.length ? canonical(before[before.length - 1].getAttribute("href") || "") : null;
          if (url) return { el, url, name: invited };
        }
      }
      if (el.tagName === "MAIN" || connectsHere.length !== 1 || targets.size !== 1) continue;
      const person = links[0];
      if (person) return { el, ...person };
    }
    return null;
  }
  function cardFor(button) {
    return personCard(button);
  }
  function isSentControl(el) {
    const text = label(el);
    if (!text || connect(el)) return false;
    return /\bpending\b|\bwithdraw\b|invitation sent|invite sent/i.test(text);
  }
  function candidates() {
    const blockingDialog = [...document.querySelectorAll('[role="dialog"], dialog[open]')].some((el) => {
      const box = el.getBoundingClientRect();
      if (box.width <= 8 || box.height <= 8) return false;
      return /send|add a note|invitation|connect/i.test(el.innerText || "");
    });
    if (blockingDialog) return [];
    const root = document.querySelector("main");
    if (!root) return [];
    return [...root.querySelectorAll("button, [role='button']")].filter((b) => visible(b) && connect(b)).flatMap((button) => {
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
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 8 && box.height > 8 && /send|add a note|invitation/i.test(el.innerText || "");
    });
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
    for (const el of controls(root)) {
      if (!isSentControl(el)) continue;
      const card = personCard(el, url);
      if (card?.url === url) return true;
    }
    return false;
  }
  function offered({ url }) {
    return candidates().some((c) => c.url === url);
  }
  function present({ url }) {
    const root = document.querySelector("main");
    if (!root) return false;
    return [...root.querySelectorAll("button, [role='button']")].some((button) => connect(button) && cardFor(button)?.url === url);
  }
  function navPoint(match) {
    for (const el of [...document.querySelectorAll("a, button, [role='button']")]) {
      if (!onscreen(el)) continue;
      const text = `${el.getAttribute("aria-label") || ""} ${label(el)}`.replace(/\s+/g, " ").trim();
      const href = el.getAttribute("href") || "";
      if (match(text, href)) return point(el);
    }
    return null;
  }
  function myNetwork() {
    return navPoint((text, href) => /my network/i.test(text) || /\/mynetwork\/?$/.test(href.split("?")[0]));
  }
  // aria-label and visible text are tested separately: a tab named "Grow" in both reads as
  // "Grow Grow" when joined. Tabs may be role="tab" or role="link" rather than a/button.
  const isGrowLabel = (value) => /^grow(?:\s*\(\d+\)|\s+\d+)?$/i.test((value || "").replace(/\s+/g, " ").trim());
  function growTab() {
    for (const el of [...document.querySelectorAll("a, button, [role='button'], [role='tab'], [role='link']")]) {
      if (!onscreen(el)) continue;
      const href = (el.getAttribute("href") || "").split("?")[0];
      if (/\/mynetwork\/grow/i.test(href) || isGrowLabel(el.getAttribute("aria-label")) || isGrowLabel(el.innerText || el.textContent)) return point(el);
    }
    return null;
  }
  // What the page offers instead of a Grow tab, for the log only.
  function networkTabs() {
    return [...document.querySelectorAll("a, button, [role='tab'], [role='link']")]
      .filter((el) => onscreen(el) && el.getBoundingClientRect().top < 320)
      .map((el) => ({ label: `${el.getAttribute("aria-label") || ""} | ${label(el)}`.slice(0, 60), href: (el.getAttribute("href") || "").split("?")[0].slice(0, 60), role: el.getAttribute("role") || el.tagName.toLowerCase() }))
      .slice(0, 30);
  }
  // Whether /mynetwork painted anything at all; an empty main means the tab row never rendered.
  function networkShape() {
    const root = document.querySelector("main");
    return {
      main: Boolean(root),
      anchors: root ? queryAll(root, "a[href]").length : 0,
      buttons: root ? controls(root).length : 0,
      text: root ? (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) : "",
    };
  }
  // Reports how far the first off-screen Connect card is from mid-viewport. It never scrolls;
  // the caller moves there with wheel input over the suggestions area.
  function revealConnect() {
    const root = document.querySelector("main");
    if (!root) return { scrolled: false, found: 0 };
    const buttons = controls(root).filter(connect);
    if (!buttons.length) return { scrolled: false, found: 0 };
    const first = buttons.find((button) => !visible(button)) || buttons[0];
    const top = Math.round(first.getBoundingClientRect().top);
    return { scrolled: false, found: buttons.length, top, delta: Math.round(top - innerHeight * 0.45), visibleNow: visible(first) };
  }
  function growReady() {
    const root = document.querySelector("main");
    if (!root) return { rendered: false };
    const people = queryAll(root, "a[href]").filter((a) => canonical(a.getAttribute("href") || "")).length;
    const cardControls = controls(root).filter((el) => connect(el) || isIgnoreInvite(el) || /^follow\b/i.test(el.getAttribute("aria-label") || label(el))).length;
    return { rendered: people > 0 || cardControls > 0, people, cardControls };
  }
  // A point inside the suggestions area for wheel input, plus the scroller's position so the
  // caller can tell whether the wheel moved it.
  function growWheelTarget() {
    const scroller = growScrollRoot();
    const root = document.querySelector("main") || document.body;
    const anchor = controls(root).find((el) => visible(el) && connect(el))
      || controls(root).find((el) => visible(el) && isIgnoreInvite(el))
      || root;
    let area = anchor.getBoundingClientRect();
    for (let el = anchor; el && el !== root && el.parentElement; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= 280 && r.height >= 120) { area = r; break; }
    }
    const top = Math.max(120, area.top + 20);
    const bottom = Math.min(innerHeight - 80, area.bottom - 20);
    const view = invitationOnlyViewport();
    const reveal = revealConnect();
    return {
      x: Math.round(area.left + Math.min(area.width / 2, 260)),
      y: Math.round(bottom > top ? (top + bottom) / 2 : Math.min(innerHeight - 120, Math.max(160, innerHeight / 2))),
      scrollTop: growScrollTop(),
      invitationOnly: view.invitationOnly,
      connectFound: view.connectFound,
      connectVisible: view.connectVisible,
      delta: reveal.found && !reveal.visibleNow ? reveal.delta : null,
    };
  }
  function growScrollTop() {
    const scroller = growScrollRoot();
    const win = typeof window !== "undefined" ? window : null;
    return Math.round(scroller.scrollTop || win?.scrollY || 0);
  }
  function isIgnoreInvite(el) {
    const text = `${el.getAttribute("aria-label") || ""} ${label(el)}`.replace(/\s+/g, " ").trim();
    return /ignore (an )?invitation|ignore .+ invitation to connect/i.test(text);
  }
  function invitationOnlyViewport() {
    const root = document.querySelector("main");
    if (!root) return { invitationOnly: false, ignoreVisible: 0, connectFound: 0, connectVisible: 0 };
    const all = controls(root);
    const ignoreVisible = all.filter((el) => visible(el) && isIgnoreInvite(el)).length;
    const connectButtons = all.filter(connect);
    const connectVisible = connectButtons.filter(visible).length;
    return {
      invitationOnly: ignoreVisible > 0 && connectVisible === 0,
      ignoreVisible,
      connectFound: connectButtons.length,
      connectVisible,
    };
  }
  function growScrollRoot() {
    const root = document.querySelector("main") || document.body;
    const connectBtn = controls(root).find(connect);
    const ignoreBtn = controls(root).find((el) => isIgnoreInvite(el));
    const start = connectBtn || ignoreBtn || root.querySelector("[data-view-name*='cogrowth'], [data-view-name*='pymk'], section") || root;
    let best = null;
    for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      const overflowY = `${style.overflowY || ""} ${style.overflow || ""}`;
      const scrollable = el.scrollHeight > el.clientHeight + 24 && /(auto|scroll)/i.test(overflowY);
      if (scrollable) best = el;
      if (el.tagName === "MAIN") break;
    }
    if (best) return best;
    const workspace = document.querySelector("main#workspace") || document.querySelector("main");
    if (workspace && workspace.scrollHeight > workspace.clientHeight + 24) return workspace;
    return document.scrollingElement || document.documentElement;
  }
  function scrollGrowTowardConnect({ deltaY = 520 } = {}) {
    const beforeView = invitationOnlyViewport();
    const scroller = growScrollRoot();
    const win = typeof window !== "undefined" ? window : null;
    const beforeTop = Math.round(scroller.scrollTop || win?.scrollY || 0);
    const beforeMax = Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
    if (typeof scroller.scrollBy === "function") scroller.scrollBy(0, deltaY);
    else scroller.scrollTop = beforeTop + deltaY;
    if (Math.abs((scroller.scrollTop || 0) - beforeTop) < 2 && typeof win?.scrollBy === "function") {
      win.scrollBy(0, deltaY);
    }
    const afterTop = Math.round(scroller.scrollTop || win?.scrollY || 0);
    const afterView = invitationOnlyViewport();
    const revealed = revealConnect();
    return {
      moved: Math.abs(afterTop - beforeTop),
      beforeTop,
      afterTop,
      beforeMax,
      invitationOnly: afterView.invitationOnly,
      connectFound: Math.max(afterView.connectFound, revealed.found || 0),
      connectVisible: afterView.connectVisible,
      ignoreVisible: afterView.ignoreVisible,
      reveal: revealed,
      beforeView,
    };
  }
  // Invitation-limit notices appear in dialogs, alerts, and toasts. The feed body is not
  // scanned: posts quote "weekly invitation limit" and would pause invites falsely.
  function limitNotice({ pattern }) {
    const re = new RegExp(pattern, "i");
    const overlays = [...document.querySelectorAll('[role="dialog"], dialog[open], [role="alertdialog"], [role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"], .artdeco-toast-item, [data-test-artdeco-toast-item-type]')];
    for (const el of overlays) {
      if (el.closest("main [data-testid='mainFeed'], [componentkey^='update-card']")) continue;
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (text && re.test(text)) return { found: true, text: text.slice(0, 200) };
    }
    return { found: false };
  }
  function visitPoint({ url }) {
    const match = candidates().find((c) => c.url === url);
    if (!match) return null;
    const anchors = queryAll(match.el, "a[href]").filter((a) => canonical(a.getAttribute("href") || "") === url && visible(a));
    const anchor = anchors.find((a) => personName(a.innerText || a.textContent || "")) || anchors[0];
    return anchor ? point(anchor) : null;
  }
  function probeVisit({ url, x, y }) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest("button, [role='button']")) return false;
    const anchor = hit.closest("a[href]");
    return Boolean(anchor && canonical(anchor.getAttribute("href") || "") === url);
  }
  function shape() {
    const root = document.querySelector("main") || document.body;
    let inLinks = 0;
    let anchors = 0;
    let shadows = 0;
    for (const anchor of queryAll(root, "a")) {
      anchors += 1;
      if (canonical(anchor.getAttribute("href") || "")) inLinks += 1;
    }
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) shadows += 1;
    const buttons = queryAll(root, "button, [role='button']").filter(connect);
    const profileLinks = queryAll(root, "a").map((anchor) => ({ url: canonical(anchor.getAttribute("href") || ""), name: personName(anchor.innerText || anchor.textContent || "") })).filter((link) => link.url);
    let prefixHits = 0;
    for (const button of buttons) {
      const invited = inviteName(button);
      if (invited && profileLinks.some((link) => samePerson(link.name, invited))) prefixHits += 1;
    }
    const onScreen = buttons.filter(visible);
    const first = onScreen.find((button) => inviteName(button)) || onScreen[0] || buttons[0];
    let firstUnique = null;
    if (first && inviteName(first)) {
      const invited = inviteName(first);
      let node = first;
      for (let depth = 0; node && depth < 40 && node.tagName !== "BODY"; depth += 1, node = node.parentElement) {
        const urls = new Set(queryAll(node, "a[href]").map((anchor) => ({ url: canonical(anchor.getAttribute("href") || ""), name: personName(anchor.innerText || anchor.textContent || "") })).filter((link) => link.url && samePerson(link.name, invited)).map((link) => link.url));
        if (urls.size === 1) { firstUnique = depth; break; }
        if (node.tagName === "MAIN") break;
      }
    }
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 8 && box.height > 8;
    }).length;
    return {
      buttons: buttons.length,
      onScreen: onScreen.length,
      withInvite: onScreen.filter((button) => inviteName(button)).length,
      dialogs,
      firstUnique,
      anchors,
      inLinks,
      namedLinks: profileLinks.filter((link) => link.name).length,
      prefixHits,
      shadows,
      innerHeight,
      top: first ? Math.round(first.getBoundingClientRect().top) : null,
    };
  }
  return { inspect, locate, probe, dialog, probeDialog, pending, offered, present, myNetwork, growTab, networkTabs, networkShape, revealConnect, growReady, growWheelTarget, growScrollTop, invitationOnlyViewport, scrollGrowTowardConnect, shape, limitNotice, visitPoint, probeVisit };
}

export async function networkDom(page, method, arg = {}) {
  return page.evaluate((source, operation, input) => (0, eval)(`(${source})`)()[operation](input), networkDomWorld.toString(), method, arg);
}

function detachedFrameError(error) {
  return /detached Frame|Execution context was destroyed|Execution context is not available/i.test(error?.message || "");
}

function safeUrl(page) {
  try { return page.url(); }
  catch (error) {
    if (detachedFrameError(error)) return null;
    throw error;
  }
}

function parsedUrl(page) {
  const url = safeUrl(page);
  try { return url ? new URL(url) : null; } catch { return null; }
}

async function adoptLivePage(page) {
  if (safeUrl(page)) return page;
  const browser = typeof page.browser === "function" ? page.browser() : page.browser;
  if (!browser?.pages) return page;
  let tabs = [];
  try { tabs = await browser.pages(); }
  catch (error) {
    if (detachedFrameError(error)) return page;
    throw error;
  }
  const live = tabs
    .map((tab) => ({ tab, url: safeUrl(tab) }))
    .filter((item) => item.url && /linkedin\.com/i.test(item.url));
  return live.find((item) => /\/mynetwork/i.test(item.url))?.tab || live[0]?.tab || page;
}

// Bounded by both wall time and poll count, so a stubbed pause cannot spin for seconds.
async function waitForPath(page, pause, matches, timeoutMs = 8_000, onHeartbeat = () => {}) {
  const deadline = Date.now() + timeoutMs;
  let current = page;
  for (let poll = 0; poll < Math.ceil(timeoutMs / 400) && Date.now() < deadline; poll += 1) {
    current = await adoptLivePage(current);
    const url = parsedUrl(current);
    if (url && matches(url.pathname)) return current;
    onHeartbeat();
    await pause(Math.min(400, Math.max(0, deadline - Date.now())));
  }
  return adoptLivePage(current);
}

const GROW_NAV_FAILED = "Grow navigation failed: My Network did not reach /mynetwork/grow/";
const isNetworkPath = (path) => /^\/mynetwork(?:\/|$)/.test(path);
const isGrowPath = (path) => /^\/mynetwork\/grow(?:\/|$)/.test(path);

function onMyNetwork(page) {
  const url = parsedUrl(page);
  return Boolean(url && ["www.linkedin.com", "linkedin.com"].includes(url.hostname) && /^\/mynetwork(?:\/|$)/.test(url.pathname));
}

function onGrow(page) {
  const url = parsedUrl(page);
  return Boolean(url && ["www.linkedin.com", "linkedin.com"].includes(url.hostname) && /^\/mynetwork\/grow(?:\/|$)/.test(url.pathname));
}

async function clickPoint(page, point, pause, { navigation = false } = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  try {
    await page.mouse.move(point.x, point.y, { steps: 3 });
    await pause(randomInt(120, 320));
    await page.mouse.click(point.x, point.y, { delay: randomInt(50, 120) });
  } catch (error) {
    // A nav click replaces the document before the input command returns.
    if (!(navigation && detachedFrameError(error))) throw error;
  }
  return true;
}

async function existingGrowTab(page) {
  const browser = typeof page.browser === "function" ? page.browser() : page.browser;
  if (!browser?.pages) return null;
  const pages = await browser.pages();
  return pages.find((tab) => tab !== page && onGrow(tab)) || null;
}

async function reloadGrow(page, pause) {
  log.info("Reloading My Network to recheck an invitation that still shows Connect.");
  try {
    if (typeof page.reload === "function") await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    else await page.goto("https://www.linkedin.com/mynetwork/grow/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    if (!detachedFrameError(error)) throw error;
  }
  page = await adoptLivePage(page);
  await pause(randomInt(1200, 2200));
  return page;
}

// /mynetwork paints its tabs a second or two after the URL changes, so the Grow tab is
// looked for repeatedly before giving up.
async function clickGrowTab(page, { pause, onHeartbeat, looks = 12 }) {
  for (let look = 0; look < looks; look += 1) {
    page = await adoptLivePage(page);
    if (onGrow(page)) return page;
    const grow = await networkDom(page, "growTab").catch(() => null);
    if (grow) {
      await clickPoint(page, grow, pause, { navigation: true });
      log.info("Pressed the Grow tab.", { look });
      return waitForPath(page, pause, isGrowPath, 10_000, onHeartbeat);
    }
    onHeartbeat();
    await pause(randomInt(400, 700));
  }
  return page;
}

async function logGrowMissing(page, message) {
  const tabs = await networkDom(page, "networkTabs").catch((error) => ({ error: error.message }));
  const shape = await networkDom(page, "networkShape").catch((error) => ({ error: error.message }));
  log.warn(message, { url: safeUrl(page), tabs, shape });
}

async function pressMyNetwork(page, pause, onHeartbeat, message) {
  const network = await networkDom(page, "myNetwork").catch(() => null);
  if (!network || !(await clickPoint(page, network, pause, { navigation: true }))) return { page, pressed: false };
  log.info(message);
  page = await waitForPath(page, pause, isNetworkPath, 8_000, onHeartbeat);
  onHeartbeat();
  return { page, pressed: true };
}

async function waitForGrowRender(page, { pause, onHeartbeat }) {
  for (let poll = 0; poll < 20; poll += 1) {
    const ready = await networkDom(page, "growReady").catch(() => null);
    if (ready?.rendered) return ready;
    onHeartbeat();
    await pause(randomInt(350, 550));
  }
  return { rendered: false };
}

async function openGrow(page, { pause, onHeartbeat = () => {} } = {}) {
  if (onGrow(page)) {
    log.info("Already on My Network Grow; using the open tab.");
    await pause(randomInt(800, 1600));
    return page;
  }
  const existing = await existingGrowTab(page);
  if (existing) {
    log.info("Switching to an already-open My Network Grow tab.", { url: existing.url() });
    const { foregroundPage } = await import("../browser/page.js");
    await foregroundPage(existing, { timeoutMs: 6_000 }).catch(() => {});
    await pause(randomInt(800, 1600));
    return existing;
  }
  // Clicks come first: a /mynetwork/grow link already on screen (the feed rail's "Grow your
  // network"), else the My Network nav. Healthy loads of bare /mynetwork redirect to /grow/
  // within ~2s; a load that paints an empty main never shows a Grow tab, so it gets one
  // more My Network press and one reload. Puppeteer goto (which the local proxy often
  // refuses with ERR_TUNNEL_CONNECTION_FAILED) is the last resort, and its failure is only
  // logged; the caller ends Grow without a pause.
  if (!onMyNetwork(page)) {
    const direct = await networkDom(page, "growTab").catch(() => null);
    if (direct && await clickPoint(page, direct, pause, { navigation: true })) {
      log.info("Pressed a My Network Grow link on this page.", { from: safeUrl(page) });
      page = await waitForPath(page, pause, isNetworkPath, 8_000, onHeartbeat);
    }
    if (!onMyNetwork(page)) ({ page } = await pressMyNetwork(page, pause, onHeartbeat, "Opened My Network from the LinkedIn nav."));
  }
  if (onMyNetwork(page) && !onGrow(page)) {
    log.info("On My Network but not Grow yet; waiting for the Grow redirect or tab.", { url: safeUrl(page) });
    page = await waitForPath(page, pause, isGrowPath, 5_000, onHeartbeat);
    if (!onGrow(page)) page = await clickGrowTab(page, { pause, onHeartbeat });
    if (!onGrow(page)) {
      await logGrowMissing(page, "Grow tab did not appear on My Network; pressing My Network once more.");
      const again = await pressMyNetwork(page, pause, onHeartbeat, "Pressed My Network again from bare /mynetwork.");
      page = again.page;
      if (again.pressed) page = await waitForPath(page, pause, isGrowPath, 5_000, onHeartbeat);
      if (!onGrow(page) && onMyNetwork(page)) page = await clickGrowTab(page, { pause, onHeartbeat, looks: 6 });
    }
    if (!onGrow(page) && onMyNetwork(page) && typeof page.reload === "function") {
      log.info("Reloading bare My Network once to let it redirect to Grow.", { url: safeUrl(page) });
      try { await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }); }
      catch (error) { log.warn("My Network reload did not settle.", { message: error.message }); }
      page = await adoptLivePage(page);
      page = await waitForPath(page, pause, isGrowPath, 6_000, onHeartbeat);
      if (!onGrow(page) && onMyNetwork(page)) page = await clickGrowTab(page, { pause, onHeartbeat, looks: 8 });
    }
  }
  if (!onGrow(page)) {
    try {
      log.info("Grow clicks failed; trying direct Grow navigation as the last resort.", { url: safeUrl(page) });
      await page.goto("https://www.linkedin.com/mynetwork/grow/", { waitUntil: "domcontentloaded", timeout: 20_000 });
      page = await waitForPath(page, pause, isGrowPath, 3_000, onHeartbeat);
    } catch (error) {
      page = await adoptLivePage(page);
      log.warn("Direct Grow navigation failed. LinkedIn proxy often blocks Puppeteer goto on local Orbita.", { message: error.message, url: safeUrl(page) });
    }
  }
  if (onGrow(page)) {
    const ready = await waitForGrowRender(page, { pause, onHeartbeat });
    log.info("Grow page reached.", { url: safeUrl(page), ...ready });
    return page;
  }
  await logGrowMissing(page, "Grow navigation failed: the browser never reached /mynetwork/grow/.");
  return page;
}

// One locate, one curved move, one hit check, one press. A failed hit check neither clicks
// nor re-hovers. `beforeClick` runs only after the hit check passes (the reservation point);
// returning a falsy value cancels the click. The press is never retried: a stalled press
// comes back as `pressUncertain` and the caller reads the page to learn whether it landed.
export async function checkedClick(page, candidate, kind, { signal, pause = sleep, deadline = Infinity, beforeClick = () => true } = {}) {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) return { clicked: false, why: "deadline" };
  const point = await networkDom(page, kind === "connect" ? "locate" : "dialog", candidate);
  if (!point || (kind !== "connect" && !point.safe)) return { clicked: false, why: "locate-miss" };
  const press = await curvedPress(page, point, {
    signal, pause, beforePress: beforeClick,
    probe: (at) => networkDom(page, kind === "connect" ? "probe" : "probeDialog", { ...candidate, ...at }),
  });
  if (press.pressed) return { clicked: true, token: press.token };
  if (press.pressUncertain) return { clicked: false, pressUncertain: true, why: press.why, token: press.token };
  return { clicked: false, why: press.why };
}

// Chooses which visible card to invite. Some cards are passed over, and the pick is uniform
// over the rest, so the batch does not walk the first unused cards in order.
export function pickGrowCandidate(candidates, { state, passed = new Set(), rng = Math.random } = {}) {
  let pool = candidates.filter((c) => !passed.has(c.url) && !(state && alreadyAttempted(state, "connect", c.url)));
  const skipped = [];
  while (pool.length > 1 && rng() < config.growSkipCardChance) {
    const index = Math.floor(rng() * pool.length);
    skipped.push(pool[index]);
    pool = pool.filter((_, i) => i !== index);
  }
  if (!pool.length) return { candidate: null, skipped };
  return { candidate: pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))], skipped };
}

// Wheel input over the suggestions area only. No "Show more" or other page-wide control is
// clicked. Returns how far the suggestions scroller moved.
async function wheelGrow(page, pause, deltaY = randomInt(180, 560)) {
  const target = await networkDom(page, "growWheelTarget").catch(() => null);
  const before = Number.isFinite(target?.scrollTop) ? target.scrollTop : null;
  if (typeof page.mouse?.wheel === "function") {
    try {
      if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) await page.mouse.move(target.x, target.y, { steps: randomInt(5, 12) });
      await page.mouse.wheel({ deltaY });
    } catch { /* next pass re-inspects */ }
  }
  await pause(randomInt(1_200, 2_800));
  const after = await networkDom(page, "growScrollTop").catch(() => null);
  return { target, deltaY, moved: before !== null && Number.isFinite(after) ? Math.abs(after - before) : null };
}

async function scrollGrow(page, pause) {
  await wheelGrow(page, pause);
}

async function visitFromGrow(page, state, { pause, signal, onHeartbeat, read, rng }) {
  const cards = (await networkDom(page, "inspect")).filter((c) => !alreadyVisited(state, c.url));
  if (!cards.length) return { page, visited: false };
  const card = cards[Math.floor(rng() * cards.length)];
  const target = await networkDom(page, "visitPoint", card);
  if (!target) return { page, visited: false };
  await page.mouse.move(target.x, target.y, { steps: randomInt(8, 16) });
  await pause(randomInt(400, 1_000));
  if (!(await networkDom(page, "probeVisit", { ...card, ...target }))) {
    log.info("Grow profile link hit check failed. Not clicking.", { url: card.url });
    return { page, visited: false };
  }
  rememberVisit(state, card.url);
  try { await page.mouse.click(target.x, target.y, { delay: randomInt(50, 120) }); }
  catch (error) { if (!detachedFrameError(error)) throw error; }
  page = await waitForPath(page, pause, (path) => /^\/in\//.test(path), 12_000);
  const url = parsedUrl(page);
  if (!url || !/^\/in\//.test(url.pathname)) return { page, visited: false };
  const block = await inspectAccount(page);
  if (block) return { page, visited: false, accountBlock: block };
  log.info("Reading a profile opened from Grow.", { url: card.url });
  await read(page, { pause, signal, onHeartbeat });
  await returnFrom(page, {
    matches: isNetworkPath,
    fallback: async () => { page = await openGrow(page, { pause, onHeartbeat }); },
    pause,
    onHeartbeat,
  });
  page = await adoptLivePage(page);
  return { page, visited: true };
}

// My Network Grow phase: optional profile views from cards and 0-4 invitations.
// `maxAttempts` is the invitation count for this session (Infinity samples one).
export async function runConnectionBatch(page, state, {
  signal, onHeartbeat = () => {}, maxDurationMs = 4 * 60_000, maxAttempts = Infinity, growVisits = 0,
  pause = sleep, gapRange = [25_000, 60_000], rng = Math.random, pickCandidate = pickGrowCandidate,
  readProfile = readProfilePage, shared = undefined,
} = {}) {
  const result = { connections: 0, attempted: 0, visits: 0, accountBlock: null, reason: null, sent: [] };
  if (state.currentRun?.testRun || state.pause) {
    log.info("Skipping Grow.", { testRun: Boolean(state.currentRun?.testRun), pause: state.pause?.kind || null });
    return result;
  }
  if (shared === undefined) { try { shared = loadSharedDay(); } catch { shared = null; } }
  if (maxAttempts !== Infinity && (!Number.isInteger(maxAttempts) || maxAttempts < 0)) throw new Error("Invalid connection trial limit");
  const requested = Math.min(maxAttempts === Infinity ? sampleGrowInvites(rng()) : maxAttempts, config.growInviteHardCap);
  let max = config.connectionsEnabled ? requested : 0;
  let budget = null;
  if (max > 0) {
    const hold = inviteHoldReason(state, new Date(), shared);
    budget = weeklyBudget(state);
    if (hold) { result.reason = hold; max = 0; }
    else if (!budget.remaining) { result.reason = "Weekly connection budget exhausted"; max = 0; }
    else max = Math.min(max, budget.remaining);
  }
  if (!max && !growVisits) {
    log.info("Skipping Grow: no invitations or views planned.", { reason: result.reason, requested });
    return result;
  }
  log.info("Starting Grow.", { invites: max, requested, growVisits, remaining: budget?.remaining ?? null });
  const deadline = Date.now() + maxDurationMs;
  let block = await inspectAccount(page);
  if (block) return { ...result, accountBlock: block };
  page = await openGrow(page, { pause, onHeartbeat });
  if (!onGrow(page)) {
    block = await inspectAccount(page);
    if (block) return { ...result, accountBlock: block };
    log.warn("Grow navigation failed; skipping invitations and Grow views this session without a pause.", { url: safeUrl(page) });
    return { ...result, reason: GROW_NAV_FAILED };
  }
  // Views happen before a random invitation slot so they are not always first or last.
  const visitSlots = Array.from({ length: growVisits }, () => Math.floor(rng() * (max + 1))).sort((a, b) => a - b);
  let visitsLeftGrow = false;
  const runVisits = async () => {
    while (visitSlots.length && visitSlots[0] <= result.attempted && Date.now() < deadline) {
      visitSlots.shift();
      if (!onGrow(page)) page = await openGrow(page, { pause, onHeartbeat });
      if (!onGrow(page)) break;
      const visit = await visitFromGrow(page, state, { pause, signal, onHeartbeat, read: readProfile, rng });
      page = visit.page;
      if (visit.accountBlock) return visit.accountBlock;
      if (visit.visited) result.visits += 1;
      if (!onMyNetwork(page)) {
        page = await openGrow(page, { pause, onHeartbeat });
        if (!onMyNetwork(page)) {
          const after = await inspectAccount(page);
          if (after) return after;
          visitsLeftGrow = true;
          return null;
        }
      }
    }
    return null;
  };
  const endedAfterVisit = () => ({ ...result, reason: "Could not return to My Network after a profile view" });
  block = await runVisits();
  if (block) return { ...result, accountBlock: block };
  if (visitsLeftGrow) return endedAfterVisit();
  if (!max) return result;
  let growNavAttempts = 0;
  const runConnects = state.actions.filter((a) => a.runId === state.currentRun?.id && a.kind === "connect").length;
  const passed = new Set();
  const lookedAt = new Set();
  let misses = 0;
  let emptyPasses = 0;
  let stuckLayoutPasses = 0;
  let lastLayoutKey = null;
  while (Date.now() < deadline && result.attempted < max) {
    onHeartbeat();
    signal?.throwIfAborted();
    block = await inspectAccount(page);
    if (block) return { ...result, accountBlock: block };
    if (/^chrome-error:/i.test(safeUrl(page) || "")) {
      log.warn("My Network tab became a browser error page; ending invitations without a pause.", { url: safeUrl(page) });
      return { ...result, reason: "Browser error page during Grow" };
    }
    const url = parsedUrl(page);
    if (!url || !["www.linkedin.com", "linkedin.com"].includes(url.hostname) || !/^\/mynetwork(?:\/|$)/.test(url.pathname)) {
      return { ...result, reason: "Unexpected navigation in My Network", accountBlock: { kind: "unexpected_page", reason: "Review unexpected My Network navigation" } };
    }
    // Suggestions live on /mynetwork/grow/; cards are never inspected on another tab.
    if (!onGrow(page)) {
      if (growNavAttempts >= 1) {
        log.warn("Grow navigation failed mid-batch; ending invitations without a pause.", { url: safeUrl(page) });
        return { ...result, reason: GROW_NAV_FAILED };
      }
      growNavAttempts += 1;
      page = await openGrow(page, { pause, onHeartbeat });
      continue;
    }
    const candidates = await networkDom(page, "inspect");
    const { candidate, skipped } = pickCandidate(candidates, { state, passed: new Set([...passed, ...lookedAt]), rng });
    for (const card of skipped || []) lookedAt.add(card.url);
    if (!candidate && candidates.some((c) => lookedAt.has(c.url)) && emptyPasses < 4) {
      // Only passed-over cards remain; scroll and let them be reconsidered.
      lookedAt.clear();
      emptyPasses += 1;
      await scrollGrow(page, pause);
      continue;
    }
    if (!candidate) {
      emptyPasses += 1;
      const labels = await page.evaluate(() => {
        const label = (el) => `${el.getAttribute("aria-label") || ""} | ${(el.innerText || "").replace(/\s+/g, " ").trim()}`.trim();
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
        };
        const all = [...document.querySelectorAll("button, [role='button']")].map((el) => ({ label: label(el), ...rect(el), disabled: Boolean(el.disabled) }));
        return {
          connectish: all.filter((row) => /connect|follow|pending|withdraw|ignore/i.test(row.label)).slice(0, 40),
          mainSample: all.filter((row) => row.label).slice(0, 20),
        };
      }).catch((error) => ({ error: error.message }));
      const layoutKey = Array.isArray(labels?.connectish)
        ? labels.connectish.map((row) => `${row.label}@${row.top}`).join("|")
        : `error:${labels?.error || "unknown"}`;
      if (layoutKey === lastLayoutKey) stuckLayoutPasses += 1;
      else {
        stuckLayoutPasses = 0;
        lastLayoutKey = layoutKey;
      }
      const viewport = await networkDom(page, "invitationOnlyViewport").catch((error) => ({ error: error.message }));
      const cardShape = emptyPasses === 1 ? await networkDom(page, "shape").catch((error) => ({ error: error.message })) : undefined;
      log.info("No unused Connect suggestion on this pass.", { emptyPasses, visible: candidates.length, url: safeUrl(page), cardShape, viewport, stuckLayoutPasses, labels });
      let reveal = await networkDom(page, "revealConnect").catch((error) => ({ error: error.message }));
      log.info("Revealing off-screen Connect cards.", reveal);
      const toward = reveal?.found && !reveal.visibleNow && Number.isFinite(reveal.delta) && Math.abs(reveal.delta) > 40
        ? Math.sign(reveal.delta) * Math.min(780, Math.max(180, Math.abs(reveal.delta)))
        : randomInt(420, 780);
      const wheeled = await wheelGrow(page, pause, toward);
      log.info("Wheeled the Grow suggestions area.", { deltaY: toward, moved: wheeled.moved, at: wheeled.target ? { x: wheeled.target.x, y: wheeled.target.y } : null });
      if (!wheeled.moved) {
        const scrolled = await networkDom(page, "scrollGrowTowardConnect", { deltaY: toward })
          .catch((error) => ({ error: error.message, moved: 0 }));
        log.info("Wheel did not move the suggestions; scrolling the suggestion scroller itself.", scrolled);
        if (scrolled?.reveal?.found) reveal = scrolled.reveal;
        if (!scrolled?.moved && !scrolled?.connectFound) {
          stuckLayoutPasses += 1;
        }
      }
      const giveUp = emptyPasses >= 16
        || (emptyPasses >= 12 && !reveal?.found)
        || (emptyPasses >= 3 && stuckLayoutPasses >= 3 && !reveal?.found)
        || (viewport?.invitationOnly && stuckLayoutPasses >= 2 && !reveal?.found);
      if (giveUp) {
        const reason = viewport?.invitationOnly && !reveal?.found
          ? "Grow page shows received invitations only; no Connect suggestions became visible"
          : stuckLayoutPasses >= 3 && !reveal?.found
            ? "Grow suggestion scroller did not advance; no Connect cards became visible"
            : "No unambiguous new connection suggestions found";
        log.warn("Ending connection batch early.", { reason, emptyPasses, stuckLayoutPasses, visible: candidates.length, attempted: result.attempted });
        return { ...result, reason };
      }
      await pause(randomInt(1500, 2800));
      continue;
    }
    emptyPasses = 0;
    stuckLayoutPasses = 0;
    lastLayoutKey = null;
    passed.add(candidate.url);
    const cardIndex = candidates.findIndex((c) => c.url === candidate.url);
    log.info("Chose a Grow card.", { name: candidate.name, index: cardIndex, visibleCandidates: candidates.length, passedOver: (skipped || []).length });
    // Dwell on the card before deciding, as a person reads the headline.
    await pause(randomInt(2500, 5500));
    signal?.throwIfAborted();
    if (Date.now() >= deadline) break;
    block = await inspectAccount(page);
    if (block) return { ...result, accountBlock: block };
    let action = null;
    const click = await checkedClick(page, candidate, "connect", {
      signal, pause, deadline,
      beforeClick: () => (action = reserveAction(state, "connect", candidate.url, { limit: runConnects + max })),
    }).catch((error) => {
      if (!action) throw error;
      return { clicked: true, error };
    });
    if (!click.clicked && !click.pressUncertain) {
      if (click.why === "not-reserved" || click.why === "deadline") {
        result.reason = click.why === "deadline" ? result.reason : "Connection budget or reservation refused";
        break;
      }
      if (click.why === "move-timeout") {
        result.reason = "Pointer stalled before Connect; nothing pressed, ending invitations for this session";
        break;
      }
      misses += 1;
      log.warn("Connect hit check failed. Not clicking this card.", { name: candidate.name, why: click.why, misses });
      if (misses >= 2) {
        result.reason = "Two Connect hit-check misses; ending invitations for this session";
        break;
      }
      await scrollGrow(page, pause);
      continue;
    }
    result.attempted += 1;
    let confirmed = false;
    let stillOffered = false;
    let limited = false;
    let pressMissed = false;
    try {
      if (click.error) throw click.error;
      {
        await pause(randomInt(2500, 4000));
        limited = await checkInviteLimit(page, state);
        block = limited ? null : await inspectAccount(page);
        if (!block && !limited && click.pressUncertain) {
          const landed = await pressOutcome(page, candidate, { pause, onHeartbeat });
          pressMissed = landed === "offered";
          log.warn("Connect press stalled; read the card instead of pressing again.", { name: candidate.name, landed });
        }
        if (!block && !limited && !pressMissed) {
          confirmed = Boolean(await networkDom(page, "pending", candidate));
          if (!confirmed) {
            const dialog = await networkDom(page, "dialog", candidate);
            if (dialog.open) {
              const send = dialog.safe ? await checkedClick(page, candidate, "send", { signal, pause, deadline }) : null;
              if (!send?.clicked && !send?.pressUncertain) result.reason = "Connection dialog needs manual review";
              else {
                await pause(randomInt(2000, 3500));
                limited = await checkInviteLimit(page, state);
                // A stalled send press that left the dialog open was not delivered. Escape
                // closes it without sending.
                if (send.pressUncertain && !limited && (await networkDom(page, "dialog", candidate)).open) {
                  await page.keyboard?.press("Escape").catch(() => {});
                  pressMissed = true;
                  log.warn("Send-without-note press stalled and the dialog is still open; closed it, invite not sent.", { name: candidate.name });
                }
              }
            }
          }
          for (let check = 0; check < 10 && !result.reason && !confirmed && !limited && !pressMissed; check += 1) {
            signal?.throwIfAborted();
            block = await inspectAccount(page);
            if (block) break;
            if (await networkDom(page, "pending", candidate)) { confirmed = true; break; }
            const remaining = await networkDom(page, "inspect");
            if (!remaining.some((item) => item.url === candidate.url)) {
              confirmed = true;
              break;
            }
            await pause(800);
            onHeartbeat();
          }
          if (!confirmed && !limited && !pressMissed && !result.reason && !block && await networkDom(page, "present", candidate)) {
            page = await reloadGrow(page, pause);
            signal?.throwIfAborted();
            block = await inspectAccount(page);
            if (!block && await networkDom(page, "pending", candidate)) confirmed = true;
            else if (!block && await networkDom(page, "present", candidate)) {
              stillOffered = true;
              recordStillOffered(state, { shared, url: candidate.url });
              saveState(state);
              log.warn("Connect is still offered after reload. Ending invitations and holding them for this profile.", { name: candidate.name, hold: state.inviteHold });
            } else if (!block) {
              for (let check = 0; check < 6 && !confirmed; check += 1) {
                if (await networkDom(page, "pending", candidate)) { confirmed = true; break; }
                const remaining = await networkDom(page, "inspect");
                if (Array.isArray(remaining) && remaining.length && !remaining.some((item) => item.url === candidate.url)) {
                  confirmed = true;
                  break;
                }
                await pause(700);
                onHeartbeat();
              }
            }
          }
        }
      }
    } catch (error) {
      result.reason = `Connection outcome uncertain: ${error.message}`;
    }
    // A limit notice, a card that still offers Connect, or a stalled press that left the card
    // or dialog untouched means LinkedIn did not send it.
    const notSent = !confirmed && (limited || stillOffered || pressMissed);
    if (notSent) finishActionNotSent(state, action);
    else finishAction(state, action, confirmed);
    result.sent.push({ name: candidate.name, url: candidate.url, confirmed, ...(notSent ? { notSent: true } : {}) });
    log.info("Connection attempt finished.", { name: candidate.name, url: candidate.url, confirmed, notSent, index: cardIndex, visibleCandidates: candidates.length, attempted: result.attempted, stillOffered, limited, pressMissed });
    if (confirmed) result.connections += 1;
    if (block) return { ...result, accountBlock: block };
    if (limited) return { ...result, reason: "Invitation limit notice; invites held until the weekly reset" };
    if (pressMissed) return { ...result, reason: "Connect press stalled and was not delivered; ending invitations without a pause" };
    if (stillOffered) return { ...result, reason: "Connect still offered after reload; invites held" };
    if (!confirmed) {
      return { ...result, accountBlock: { kind: "uncertain_connection", reason: result.reason || "Connection was not confirmed as pending; inspect invitations before resuming" } };
    }
    if (result.attempted >= max) break;
    block = await runVisits();
    if (block) return { ...result, accountBlock: block };
    if (visitsLeftGrow) return endedAfterVisit();
    // Brief pauses during the gap keep cancellation responsive, including after Mac sleep.
    const nextAt = Math.min(deadline, Date.now() + randomInt(...gapRange));
    while (Date.now() < nextAt) { onHeartbeat(); signal?.throwIfAborted(); await pause(Math.min(1000, nextAt - Date.now())); }
    await scrollGrow(page, pause);
  }
  if (Date.now() < deadline) {
    block = await runVisits();
    if (block) return { ...result, accountBlock: block };
    if (visitsLeftGrow) return endedAfterVisit();
  }
  return result;
}

// After a stalled Connect press: "pending" or "dialog" means it landed, "offered" means the
// card still shows Connect untouched (not delivered), "gone" is left to the normal checks.
export async function pressOutcome(page, candidate, { pause = sleep, onHeartbeat = () => {}, looks = 4 } = {}) {
  for (let look = 0; look < looks; look += 1) {
    if (await networkDom(page, "pending", candidate)) return "pending";
    if ((await networkDom(page, "dialog", candidate))?.open) return "dialog";
    if (look === looks - 1) break;
    onHeartbeat();
    await pause(800);
  }
  return (await networkDom(page, "present", candidate)) ? "offered" : "gone";
}

// Scans only overlays after an invitation click. A notice holds invites until the weekly reset.
export async function checkInviteLimit(page, state) {
  const notice = await networkDom(page, "limitNotice", { pattern: INVITE_LIMIT_RE.source }).catch(() => ({ found: false }));
  if (!notice?.found) return false;
  recordInviteLimit(state, { text: notice.text });
  saveState(state);
  log.warn("Invitation limit notice appeared. Holding invites until the weekly reset.", { text: notice.text, hold: state.inviteHold });
  return true;
}
