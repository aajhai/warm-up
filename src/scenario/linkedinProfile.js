import { config } from "../config.js";
import { alreadyVisited, finishAction, finishActionNotSent, rememberVisit, reserveAction } from "../activity.js";
import { inviteHoldReason, loadSharedDay, recordStillOffered } from "../inviteHold.js";
import { saveState } from "../sessionState.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, logsDir } from "../logger.js";
import { curvedPress } from "../human/press.js";
import { randomInt, sleep } from "../util/random.js";
import { inspectAccount } from "./accountGuard.js";
import { checkInviteLimit, networkDom } from "./linkedinNetwork.js";

const log = createLogger("profile");

export function profileDomWorld() {
  const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const accessibleName = (el) => (el.getAttribute("aria-label") || text(el)).replace(/\s+/g, " ").trim();
  const onscreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 60 && r.top < innerHeight - 40 && getComputedStyle(el).visibility !== "hidden";
  };
  const point = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const canonical = (href) => {
    try {
      const url = new URL(href, location.origin);
      if (!["www.linkedin.com", "linkedin.com"].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/(in|company)\/([^/?#]+)/i);
      return match ? `https://www.linkedin.com/${match[1].toLowerCase()}/${decodeURIComponent(match[2]).toLowerCase()}/` : null;
    } catch { return null; }
  };
  const samePerson = (a, b) => {
    const left = (a || "").toLowerCase().trim();
    const right = (b || "").toLowerCase().trim();
    return Boolean(left && right) && (left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `));
  };
  // Profile pages without a `main h1` (seen live on 2026-09-27) take the name from the tab
  // title ("Rahul Kale | LinkedIn").
  const titleName = () => (document.title || "").replace(/^\(\d+\)\s*/, "").split("|")[0].trim();
  function profileName() {
    const h1 = document.querySelector("main h1");
    return h1 ? text(h1) : titleName();
  }
  // With an h1 the top card is its section and a bare "Connect" counts. Without one the whole
  // main is searched, so only "Invite {this profile's name} to connect" counts: a "People also
  // viewed" Connect names someone else and a bare Connect is ambiguous.
  function topCard() {
    const h1 = document.querySelector("main h1");
    if (h1) return { root: h1.closest("section") || h1.closest("main"), strict: false };
    const main = document.querySelector("main");
    return main && titleName() ? { root: main, strict: true } : null;
  }
  const CONTROL = "button, [role='button'], a[href]";
  // Only a visible top-card control named exactly "Connect" or "Invite {Name} to connect"
  // (LinkedIn renders the latter as an <a href="/preload/custom-invite/...">). Message, Follow,
  // More, and anything inside a menu or the side rail are never returned.
  function isConnectButton(button, name, strict = false) {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    if (button.closest("aside, [role='menu'], [role='dialog'], [aria-modal='true'], nav, header")) return false;
    if (/search-custom-invite/i.test(button.getAttribute("href") || "")) return false;
    const label = accessibleName(button);
    if (label === "Connect") return !strict && button.tagName !== "A";
    const match = label.match(/^Invite (.+) to connect$/);
    return Boolean(match && samePerson(match[1], name));
  }
  // The top card and a sticky header can both carry the same "Invite {Name} to connect";
  // identical invite labels for this person are one control, anything else is ambiguous.
  function single(list) {
    if (list.length === 1) return list[0];
    const first = list[0] && accessibleName(list[0]);
    return list.length > 1 && /^Invite .+ to connect$/.test(first) && list.every((b) => accessibleName(b) === first) ? list[0] : null;
  }
  function connectPoint() {
    const card = topCard();
    const name = profileName();
    if (!card || !name) return { found: false, reason: "no-profile-card" };
    const buttons = [...card.root.querySelectorAll(CONTROL)].filter((b) => onscreen(b) && isConnectButton(b, name, card.strict));
    const button = single(buttons);
    if (!button) return { found: false, reason: buttons.length ? "ambiguous-connect" : "no-connect" };
    return { found: true, name, label: accessibleName(button), ...point(button) };
  }
  function probeConnect({ x, y }) {
    const card = topCard();
    const name = profileName();
    const host = document.elementFromPoint(x, y)?.closest(CONTROL);
    return Boolean(card && host && card.root.contains(host) && isConnectButton(host, name, card.strict));
  }
  function pendingOnProfile() {
    const card = topCard();
    if (!card) return false;
    const name = profileName();
    return [...card.root.querySelectorAll(CONTROL)].some((b) => {
      const label = accessibleName(b);
      if (b.closest("aside, [role='menu']")) return false;
      // Without a top card, only a pending control that names this person counts.
      if (card.strict) return new RegExp(`^(pending|withdraw invitation).*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(label);
      return /^pending$|withdraw invitation|^pending,|invitation sent/i.test(label);
    });
  }
  // `all` also returns off-screen links (with their top) so the caller can wheel to one.
  function companyLinks({ all = false } = {}) {
    const root = document.querySelector("main");
    if (!root) return [];
    const seen = new Set();
    const out = [];
    for (const a of root.querySelectorAll("a[href]")) {
      const url = canonical(a.getAttribute("href") || "");
      if (!url || !url.includes("/company/") || seen.has(url) || a.closest("aside, nav, header, [role='menu']")) continue;
      const r = a.getBoundingClientRect();
      if (all ? r.width <= 4 || r.height <= 4 : !onscreen(a)) continue;
      seen.add(url);
      out.push({ url, ...point(a), top: r.top });
    }
    return out.slice(0, all ? 8 : 4);
  }
  // Where the exact top-card Connect is, even when a read has scrolled it off screen.
  function connectWhere() {
    const card = topCard();
    const name = profileName();
    if (!card || !name) return { found: false, reason: "no-profile-card", buttons: [] };
    const all = [...card.root.querySelectorAll(CONTROL)].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 4 && r.height > 4 && !b.closest("aside"); });
    const exact = all.filter((b) => isConnectButton(b, name, card.strict));
    const buttons = all.map((b) => accessibleName(b).slice(0, 40)).filter(Boolean).slice(0, 12);
    const one = single(exact);
    if (!one) return { found: false, reason: exact.length ? "ambiguous-connect" : "no-connect", buttons };
    return { found: true, top: one.getBoundingClientRect().top, visible: exact.some(onscreen), buttons };
  }
  function probeLink({ url, x, y }) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest("button, [role='button']")) return false;
    const anchor = hit.closest("a[href]");
    return Boolean(anchor && canonical(anchor.getAttribute("href") || "") === url);
  }
  // The header sits in the top ~52px, so it uses its own visibility test; `onscreen` is for
  // page content and rejects anything ending above y=60.
  const inHeaderBand = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < 140 && getComputedStyle(el).visibility !== "hidden";
  };
  const SEARCH_INPUT = "header input, nav input, input[role='combobox'], input[placeholder*='Search' i], input[aria-label*='Search' i]";
  // The focused search input wins: clicking the redesigned header box can move focus into a
  // second input in the expanded typeahead, and that is the one that receives the keys.
  function searchInput() {
    const active = document.activeElement;
    const typable = active?.tagName === "INPUT" && !["hidden", "checkbox", "radio", "button", "submit"].includes(active.type) && !active.closest("main");
    if (typable && (active.matches(SEARCH_INPUT) || inHeaderBand(active))) return active;
    const inputs = [...document.querySelectorAll(SEARCH_INPUT)].filter((el) => el.type !== "hidden" && !el.closest("main"));
    return inputs.find(inHeaderBand) || null;
  }
  const describe = (el) => (el ? `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${(el.getAttribute("aria-label") || el.getAttribute("placeholder") || text(el)).slice(0, 40)}`.trim() : null);
  function searchDiagnostics({ x, y } = {}) {
    return { hit: Number.isFinite(x) ? describe(document.elementFromPoint(x, y)) : null, active: describe(document.activeElement), input: describe(searchInput()) };
  }
  const isSearchOpener = (el) => /^(search|click to start a search)$/i.test(accessibleName(el));
  function searchBox() {
    const input = searchInput();
    if (input) return { kind: "input", value: input.value || "", ...point(input) };
    const opener = [...document.querySelectorAll("header button, nav button, header a, nav a, button[aria-label*='search' i], [role='button'][aria-label*='search' i]")]
      .find((el) => !el.closest("main") && inHeaderBand(el) && isSearchOpener(el));
    return opener ? { kind: "opener", ...point(opener) } : null;
  }
  // The "People" filter on a results page; the global nav has no control with that name.
  const FILTER = "button, a[href], [role='button'], [role='tab'], [role='radio']";
  const keywordsOf = (href) => { try { return (new URL(href, location.href).searchParams.get("keywords") || "").trim().toLowerCase(); } catch { return ""; } };
  // "People", "People 12K", "People filter", or a link to the People results for the same keywords.
  function isPeopleFilter(el) {
    if (el.closest("aside, [role='menu'], [role='dialog']")) return false;
    const href = el.tagName === "A" ? el.getAttribute("href") : "";
    const labelled = /^people(\s*[\d,.]+[km]?)?(,?\s*filter)?$/i.test(accessibleName(el));
    if (!href) return labelled;
    let path;
    try { path = new URL(href, location.href).pathname; } catch { return false; }
    // A link, whatever its label, must lead to People results for these same keywords.
    const here = keywordsOf(location.href);
    return /^\/search\/results\/people\/?$/.test(path) && (!here || keywordsOf(href) === here);
  }
  const inBand = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 40 && r.top < innerHeight - 40; };
  function peopleFilter() {
    const filter = [...document.querySelectorAll(FILTER)].find((el) => isPeopleFilter(el) && inBand(el));
    return filter ? point(filter) : null;
  }
  // The hit under a point, followed down through open shadow roots.
  function deepHit(x, y) {
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit?.shadowRoot && depth < 10; depth += 1) {
      const inner = hit.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }
  function probePeopleFilter({ x, y }) {
    const host = deepHit(x, y)?.closest(FILTER);
    return Boolean(host && isPeopleFilter(host));
  }
  // Click-free capture of a search results page. Counts only, a capped sample of visible
  // control labels, and People candidates for these keywords. Hrefs are reduced to path and
  // keywords; no page text, input values, or other query parameters.
  function resultsCapture() {
    const here = keywordsOf(location.href);
    let host = "";
    try { host = new URL(location.href).hostname; } catch {}
    const hrefSummary = (href) => {
      try {
        const u = new URL(href, location.href);
        const kw = (u.searchParams.get("keywords") || "").trim();
        return `${u.hostname && u.hostname !== host ? u.hostname : ""}${u.pathname}${kw ? `?keywords=${kw}` : ""}`.slice(0, 90);
      } catch { return ""; }
    };
    const roots = [document];
    for (let i = 0; i < roots.length && roots.length < 400; i += 1) {
      for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    const tally = (list) => {
      const out = { a: 0, button: 0, roleButton: 0, roleTab: 0 };
      for (const root of list) {
        out.a += root.querySelectorAll("a").length;
        out.button += root.querySelectorAll("button").length;
        out.roleButton += root.querySelectorAll("[role='button']").length;
        out.roleTab += root.querySelectorAll("[role='tab']").length;
      }
      return out;
    };
    const labels = [];
    const peopleMentions = [];
    let people = null;
    roots.forEach((root, index) => {
      const where = index === 0 ? "doc" : "shadow";
      for (const el of root.querySelectorAll(FILTER)) {
        const label = accessibleName(el).slice(0, 40);
        const href = el.tagName === "A" ? hrefSummary(el.getAttribute("href") || "") : "";
        const visible = inBand(el);
        const tag = el.tagName.toLowerCase();
        if (visible && labels.length < 40 && (label || href)) labels.push(`${where}:${tag}:${label}${href ? ` ${href}` : ""}`);
        const qualifies = isPeopleFilter(el);
        if ((qualifies || /people/i.test(label) || /\/search\/results\/people/i.test(href)) && peopleMentions.length < 10) {
          peopleMentions.push({ where, tag, label, href, visible, qualifies });
        }
        if (!people && visible && qualifies) people = { ...point(el), where, label, href };
      }
    });
    const iframes = [...document.querySelectorAll("iframe")].slice(0, 10).map((frame) => {
      const r = frame.getBoundingClientRect();
      let inner = null;
      try {
        const doc = frame.contentDocument;
        if (doc) inner = { a: doc.querySelectorAll("a").length, button: doc.querySelectorAll("button").length, roleButton: doc.querySelectorAll("[role='button']").length };
      } catch {}
      let src = "";
      try { const u = new URL(frame.getAttribute("src") || "about:blank", location.href); src = `${u.protocol === "about:" ? "about:" : u.hostname}${u.pathname}`.slice(0, 80); } catch {}
      return { src, width: Math.round(r.width), height: Math.round(r.height), sameOrigin: Boolean(inner), inner };
    });
    const main = document.querySelector("main");
    let url = "";
    try { const u = new URL(location.href); url = `${u.origin}${u.pathname}${here ? `?keywords=${u.searchParams.get("keywords")}` : ""}`; } catch {}
    return {
      url,
      readyState: document.readyState,
      iframeCount: document.querySelectorAll("iframe").length,
      iframes,
      shadowRootCount: roots.length - 1,
      doc: tally([document]),
      shadow: tally(roots.slice(1)),
      mainPresent: Boolean(main),
      mainTextLength: main ? text(main).length : 0,
      visibleLabels: labels,
      peopleMentions,
      people,
    };
  }
  function filterDiagnostics() {
    const seen = [...document.querySelectorAll(FILTER)].filter(inBand).filter((el) => !el.closest("aside, nav, header")).slice(0, 14);
    return seen.map((el) => `${el.tagName.toLowerCase()}:${accessibleName(el).slice(0, 30)}${el.tagName === "A" ? ` ${(el.getAttribute("href") || "").slice(0, 50)}` : ""}`);
  }
  function probeSearchBox({ kind, x, y }) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    if (kind === "input") {
      const input = searchInput();
      if (!input) return false;
      if (hit === input || input.contains(hit) || hit.contains(input)) return true;
      // A placeholder or icon layered over the box: fine inside the same search container,
      // never a button or link.
      const box = input.closest("[role='combobox'], [role='search'], form");
      return Boolean(box && box.contains(hit) && !hit.closest("button, a, [role='button']") && !hit.closest("main"));
    }
    const host = hit.closest("button, a, [role='button']");
    return Boolean(host && isSearchOpener(host));
  }
  function searchFocused() {
    const input = searchInput();
    return Boolean(input && document.activeElement === input);
  }
  function searchValue() {
    const input = searchInput();
    return input ? String(input.value ?? "") : null;
  }
  // Selects the box's own text through the input node (Meta+A did not select in Orbita), so
  // one Backspace replaces all of it. The value itself is never written from script.
  function selectSearchText() {
    const input = searchInput();
    if (!input || document.activeElement !== input || typeof input.select !== "function") return false;
    input.select();
    const value = String(input.value ?? "");
    return input.selectionStart === 0 && input.selectionEnd === value.length;
  }
  // The global-nav Home link (an icon-only /feed/ link in the redesigned header).
  const feedLink = (el) => {
    try { return (new URL(el.getAttribute("href") || "", location.origin).pathname.replace(/\/+$/, "") || "/") === "/feed"; }
    catch { return false; }
  };
  function homeLink() {
    const home = [...document.querySelectorAll("a[href]")].find((a) => feedLink(a) && inHeaderBand(a) && !a.closest("main")
      && (/\bhome\b/i.test(accessibleName(a)) || a.closest("header, nav") || a.getBoundingClientRect().bottom <= 90));
    return home ? point(home) : null;
  }
  function probeHome({ x, y }) {
    const anchor = document.elementFromPoint(x, y)?.closest("a[href]");
    return Boolean(anchor && feedLink(anchor) && !anchor.closest("main"));
  }
  // The header typeahead: a visible listbox or suggestion panel under the search box, or a
  // visible "See all results" item. While it is open the results behind it are dimmed.
  function typeahead() {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden"; };
    const panels = [...document.querySelectorAll("[role='listbox'], [id*='typeahead' i][role], [class*='typeahead' i][class*='overlay' i], [class*='typeahead' i][class*='results' i], [data-testid*='typeahead' i]")]
      .filter((el) => el.tagName !== "INPUT" && shown(el));
    const seeAll = [...document.querySelectorAll("a, button, [role='option'], [role='button'], li, div, span")]
      .find((el) => /^see all results$/i.test(text(el)) && shown(el) && ![...el.children].some((child) => /^see all results$/i.test(text(child))));
    const open = panels.length > 0 || Boolean(seeAll);
    return { open, panels: panels.length, seeAll: seeAll ? point(seeAll) : null };
  }
  function probeSeeAll({ x, y }) {
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && /^see all results$/i.test(text(hit.closest("a, button, [role='option'], [role='button'], li") || hit)));
  }
  function peopleResults() {
    const root = document.querySelector("main");
    if (!root) return [];
    const seen = new Set();
    const out = [];
    for (const a of root.querySelectorAll("a[href]")) {
      const url = canonical(a.getAttribute("href") || "");
      const name = text(a).split(/\s+[•·|]\s+/)[0].trim();
      if (!url || !url.includes("/in/") || !name || name.length > 80 || seen.has(url) || a.closest("aside, nav, header")) continue;
      if (/^(view|see|show)\b/i.test(name)) continue;
      seen.add(url);
      const r = a.getBoundingClientRect();
      out.push({ url, name, x: r.x + Math.min(r.width / 2, 60), y: r.y + r.height / 2, top: r.top });
    }
    return out;
  }
  return { profileName, connectPoint, connectWhere, probeConnect, pendingOnProfile, companyLinks, probeLink, searchBox, probeSearchBox, searchFocused, searchValue, selectSearchText, searchDiagnostics, homeLink, probeHome, typeahead, probeSeeAll, peopleFilter, probePeopleFilter, filterDiagnostics, resultsCapture, peopleResults };
}

export async function profileDom(page, method, arg = {}) {
  return page.evaluate((source, operation, input) => (0, eval)(`(${source})`)()[operation](input), profileDomWorld.toString(), method, arg);
}

function pathOf(page) {
  try { return new URL(page.url()).pathname; } catch { return ""; }
}

function safeHref(page) {
  try { return page.url(); } catch { return null; }
}

// The All results page can take well over 5 seconds to paint anything clickable. Waits up to
// ~15 seconds (heartbeat throughout) for a People control, then returns the last capture.
async function captureResults(page, pause, onHeartbeat = () => {}, looks = 22) {
  let capture = null;
  for (let look = 0; look < looks; look += 1) {
    capture = await profileDom(page, "resultsCapture").catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
    if (capture?.people) return { ...capture, looks: look + 1 };
    onHeartbeat();
    await pause(randomInt(550, 800));
  }
  return { ...capture, looks };
}

function writeResultsDump(capture, extra) {
  try {
    mkdirSync(logsDir, { recursive: true });
    const path = join(logsDir, `${Date.now()}-search-results-dump.json`);
    writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...extra, ...capture }, null, 2));
    log.info("Wrote search results dump.", {
      path,
      iframeCount: capture?.iframeCount,
      shadowRootCount: capture?.shadowRootCount,
      doc: capture?.doc,
      shadow: capture?.shadow,
      visibleLabels: capture?.visibleLabels?.length ?? 0,
      peopleMentions: capture?.peopleMentions?.length ?? 0,
      people: capture?.people ? { where: capture.people.where, label: capture.people.label, href: capture.people.href } : null,
      error: capture?.error,
    });
    return path;
  } catch (error) {
    log.warn("Search results dump failed", { message: error.message });
    return null;
  }
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

async function waitForPath(page, matches, { pause = sleep, timeoutMs = 10_000, onHeartbeat = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let poll = 0; poll < Math.ceil(timeoutMs / 400) && Date.now() < deadline; poll += 1) {
    if (matches(pathOf(page))) return true;
    onHeartbeat();
    await pause(Math.min(400, Math.max(0, deadline - Date.now())));
  }
  return matches(pathOf(page));
}

async function wheel(page, deltaY) {
  try {
    if (typeof page.mouse?.wheel !== "function") throw new Error("no wheel");
    await withTimeout(page.mouse.wheel({ deltaY }), 5_000, "profile wheel timed out");
  } catch {
    await page.evaluate((dy) => window.scrollBy(0, dy), deltaY).catch(() => {});
  }
}

// Reads a profile or company page by scrolling and dwelling only. It never clicks, so it
// cannot press Message, Follow, More, or Connect.
export async function readProfilePage(page, { pause = sleep, signal, onHeartbeat = () => {} } = {}) {
  const kind = /^\/company\//.test(pathOf(page)) ? "company" : "person";
  onHeartbeat();
  try {
    if (typeof page.mouse?.move === "function") await withTimeout(page.mouse.move(randomInt(380, 620), randomInt(260, 420), { steps: randomInt(8, 18) }), 5_000, "move timed out");
  } catch { /* reading continues without a pointer move */ }
  await pause(randomInt(3_000, 6_500));
  const steps = randomInt(3, 7);
  for (let i = 0; i < steps; i += 1) {
    signal?.throwIfAborted();
    onHeartbeat();
    const reverse = i > 1 && Math.random() < 0.15;
    await wheel(page, reverse ? -randomInt(120, 260) : randomInt(220, 520));
    await pause(randomInt(1_800, 5_200));
  }
  onHeartbeat();
  return { read: true, kind, steps };
}

const onErrorPage = (page) => { try { return /^chrome-error:/i.test(page.url()); } catch { return false; } };
const navigationRace = (error) => /detached Frame|Execution context|Target closed|navigation/i.test(error?.message || "");

// Returns by the LinkedIn nav only (`fallback` clicks Home or My Network). Browser Back is
// never used: it is a history load through the local proxy that has landed on chrome-error
// pages, and Back from an error page skips to the page before it. If the click does not
// return, an error page is reloaded, and then `reloadUrl` (the feed) is loaded once. A
// failed return is reported to the caller, which carries on; it is never a pause.
export async function returnFrom(page, { matches, fallback = async () => {}, reloadUrl = null, pause = sleep, onHeartbeat = () => {} } = {}) {
  onHeartbeat();
  try { await fallback(); }
  catch (error) { if (!navigationRace(error)) throw error; }
  onHeartbeat();
  if (await waitForPath(page, matches, { pause, timeoutMs: 8_000, onHeartbeat })) return true;
  if (onErrorPage(page) && typeof page.reload === "function") {
    log.warn("Return navigation landed on a browser error page; reloading it.", { url: safeHref(page) });
    try { await withTimeout(page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }), 21_000, "reload timed out"); }
    catch (error) { log.info("Reload after error page did not settle.", { message: error.message }); }
    onHeartbeat();
    if (await waitForPath(page, matches, { pause, timeoutMs: 6_000, onHeartbeat })) return true;
  }
  if (reloadUrl && typeof page.goto === "function") {
    log.info("The nav click did not return; loading the page once.", { to: reloadUrl, from: safeHref(page) });
    try { await withTimeout(page.goto(reloadUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }), 31_000, "return load timed out"); }
    catch (error) { log.warn("Return load failed.", { message: error.message }); }
    onHeartbeat();
    if (await waitForPath(page, matches, { pause, timeoutMs: 6_000, onHeartbeat })) return true;
  }
  return matches(pathOf(page));
}

const isFeedPath = (path) => /^\/feed\/?$/.test(path);

// Home nav click first; see returnFrom for what follows a click that does not land.
export async function returnHome(page, { pause = sleep, onHeartbeat = () => {} } = {}) {
  if (isFeedPath(pathOf(page)) && !onErrorPage(page)) return true;
  const back = await returnFrom(page, {
    matches: isFeedPath,
    fallback: async () => {
      const home = await profileDom(page, "homeLink").catch(() => null);
      if (!home) log.info("Home nav link was not found on this page.", { url: safeHref(page) });
      else if (await clickLinkOnce(page, home, { pause, probe: "probeHome" })) log.info("Pressed Home in the LinkedIn nav.", { from: safeHref(page) });
      else log.info("Home nav hit check failed; not clicking.", { from: safeHref(page) });
    },
    reloadUrl: config.feedUrl,
    pause,
    onHeartbeat,
  });
  if (back) log.info("Back on the home feed.");
  else log.warn("Could not return to the home feed; continuing the session without it.", { url: safeHref(page) });
  return back;
}

async function clickLinkOnce(page, target, { pause, world = profileDom, probe = "probeLink" }) {
  await page.mouse.move(target.x, target.y, { steps: randomInt(8, 16) });
  await pause(randomInt(300, 800));
  if (!(await world(page, probe, target))) return false;
  try { await page.mouse.click(target.x, target.y, { delay: randomInt(50, 120) }); }
  catch (error) { if (!/detached Frame|Execution context/i.test(error.message)) throw error; }
  return true;
}

// Sends at most one invitation from an open profile. One locate, one move, one hit check,
// one click. The reservation is written only after the hit check passes.
export async function profileConnect(page, state, { url, signal, pause = sleep, shared = null } = {}) {
  const out = { attempted: 0, connections: 0, sent: [], accountBlock: null, reason: null };
  if (!config.connectionsEnabled || state.currentRun?.testRun || state.currentRun?.connectionTrial || state.pause) return { ...out, reason: "Profile connect not allowed in this run" };
  const hold = inviteHoldReason(state, new Date(), shared);
  if (hold) return { ...out, reason: hold };
  // Only an open person profile: a search-results row or list Connect is never pressed.
  if (!/^\/in\/[^/]+/.test(pathOf(page))) {
    log.info("Not on a person profile; profile Connect skipped.", { url: safeHref(page) });
    return { ...out, reason: "not-on-profile" };
  }
  // A read scrolls the top card away; wheel back to the exact Connect before locating it.
  let where = await profileDom(page, "connectWhere").catch(() => null);
  for (let step = 0; step < 4 && where?.found && !where.visible; step += 1) {
    await wheel(page, Math.max(-900, Math.min(900, Math.round(where.top - 300))));
    await pause(randomInt(600, 1_200));
    where = await profileDom(page, "connectWhere").catch(() => null);
  }
  const target = await profileDom(page, "connectPoint");
  if (!target?.found) {
    log.info("No exact Connect button on this profile's top card. Not opening More. The run's profile-connect attempt is kept for a later profile.", { reason: target?.reason, topCardButtons: where?.buttons || [] });
    return { ...out, reason: target?.reason || "no-connect" };
  }
  // The run's single attempt is spent only once an exact control for this person is found,
  // whether or not the hit check then passes.
  markConnectTried(state);
  log.info("Exact top-card Connect is on screen.", { label: target.label, name: target.name });
  let action = null;
  const usedInRun = state.actions.filter((a) => a.runId === state.currentRun.id && a.kind === "connect").length;
  let press;
  try {
    press = await curvedPress(page, target, {
      signal, pause,
      probe: (at) => profileDom(page, "probeConnect", { ...target, ...at }),
      beforePress: () => (action = reserveAction(state, "connect", url, { limit: usedInRun + 1 })),
    });
  } catch (error) {
    if (!action) throw error;
    press = { pressed: true, error };
  }
  if (!press.pressed && !press.pressUncertain) {
    if (press.why === "not-reserved") return { ...out, reason: "Connection budget or reservation refused" };
    log.warn("Profile Connect was not pressed.", { url, why: press.why });
    return { ...out, reason: press.why === "hit-miss" ? "hit-check-failed" : press.why };
  }
  out.attempted = 1;
  let confirmed = false;
  const notSent = (reason) => {
    finishActionNotSent(state, action);
    out.sent.push({ name: target.name, url, confirmed: false, notSent: true });
    return { ...out, reason };
  };
  try {
    if (press.error) throw press.error;
    await pause(randomInt(2_000, 3_500));
    if (await checkInviteLimit(page, state)) return notSent("Invitation limit notice");
    const block = await inspectAccount(page);
    if (block) {
      finishAction(state, action, false);
      return { ...out, accountBlock: block };
    }
    if (press.pressUncertain) {
      let landed = false;
      for (let look = 0; look < 4 && !landed; look += 1) {
        landed = Boolean(await profileDom(page, "pendingOnProfile")) || Boolean((await networkDom(page, "dialog", { name: target.name }))?.open);
        if (!landed) await pause(800);
      }
      if (!landed && (await profileDom(page, "connectPoint"))?.found) {
        log.warn("Profile Connect press stalled and the top card still offers Connect; not pressing again.", { url });
        return notSent("Connect press stalled and was not delivered");
      }
    }
    const dialog = await networkDom(page, "dialog", { name: target.name });
    if (dialog?.open) {
      if (!dialog.safe) out.reason = "Connection dialog needs manual review";
      else {
        const send = await curvedPress(page, dialog, { signal, pause, probe: (at) => networkDom(page, "probeDialog", { name: target.name, ...at }) });
        if (send.pressed || send.pressUncertain) {
          await pause(randomInt(1_800, 3_000));
          if (await checkInviteLimit(page, state)) return notSent("Invitation limit notice");
          if (send.pressUncertain && (await networkDom(page, "dialog", { name: target.name }))?.open) {
            await page.keyboard?.press("Escape").catch(() => {});
            log.warn("Send-without-note press stalled and the dialog is still open; closed it, invite not sent.", { url });
            return notSent("Send press stalled and was not delivered");
          }
        } else out.reason = "Connection dialog needs manual review";
      }
    }
    for (let check = 0; check < 10 && !out.reason && !confirmed; check += 1) {
      if (await profileDom(page, "pendingOnProfile")) confirmed = true;
      else await pause(800);
    }
    if (!confirmed && !out.reason && (await profileDom(page, "connectPoint"))?.found) {
      try { await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }); } catch { /* recheck below */ }
      await pause(randomInt(1_500, 2_500));
      if (await profileDom(page, "pendingOnProfile")) confirmed = true;
      else if ((await profileDom(page, "connectPoint"))?.found) {
        recordStillOffered(state, { shared, url });
        saveState(state);
        log.warn("Profile still offers Connect after reload. Holding invites.", { url, hold: state.inviteHold });
        finishActionNotSent(state, action);
        out.sent.push({ name: target.name, url, confirmed: false, notSent: true });
        return { ...out, reason: "Connect still offered after reload" };
      }
    }
  } catch (error) {
    out.reason = `Connection outcome uncertain: ${error.message}`;
  }
  finishAction(state, action, confirmed);
  out.sent.push({ name: target.name, url, confirmed });
  if (confirmed) out.connections = 1;
  else out.accountBlock = { kind: "uncertain_connection", reason: out.reason || "Profile connection was not confirmed as pending; inspect invitations before resuming" };
  log.info("Profile connection attempt finished.", { url, name: target.name, confirmed });
  return out;
}

// Run-scoped verification flags so the feed and search share one company view and one
// profile Connect attempt.
function verified(state) {
  if (!state.currentRun) return {};
  state.currentRun.verified ||= {};
  return state.currentRun.verified;
}

export function verifyNeeds(state) {
  const done = verified(state);
  return { company: !done.company, connect: !done.connectTried };
}

export function markConnectTried(state) {
  verified(state).connectTried = true;
}

// From an open person profile, opens one company link (experience or top card), reads it by
// scrolling only, and stays on the company page. Nothing on the company page is clicked.
export async function visitCompanyFromProfile(page, state, { pause = sleep, signal, onHeartbeat = () => {}, read = readProfilePage, rng = Math.random } = {}) {
  const unvisited = (list) => (Array.isArray(list) ? list : []).filter((c) => !alreadyVisited(state, c.url));
  let companies = unvisited(await profileDom(page, "companyLinks").catch(() => []));
  if (!companies.length) {
    const offscreen = unvisited(await profileDom(page, "companyLinks", { all: true }).catch(() => []));
    if (offscreen.length) {
      await wheel(page, Math.max(-900, Math.min(900, Math.round(offscreen[0].top - 380))));
      await pause(randomInt(700, 1_400));
      companies = unvisited(await profileDom(page, "companyLinks").catch(() => []));
    }
  }
  if (!companies.length) {
    log.info("No unvisited company link on this profile; company view skipped.", { url: safeHref(page) });
    return { visited: false };
  }
  const company = companies[Math.floor(rng() * companies.length)];
  rememberVisit(state, company.url);
  if (!(await clickLinkOnce(page, company, { pause }))) {
    log.info("Company link hit check failed; not clicking.", { url: company.url });
    return { visited: false };
  }
  if (!(await waitForPath(page, (path) => /^\/company\//.test(path), { pause, timeoutMs: 12_000, onHeartbeat }))) {
    log.info("Company page did not open from the profile.", { url: safeHref(page) });
    return { visited: false };
  }
  const block = await inspectAccount(page);
  if (block) return { visited: false, accountBlock: block };
  log.info("Reading a company page (scroll only, nothing clicked).", { url: company.url, at: safeHref(page) });
  await read(page, { pause, signal, onHeartbeat });
  verified(state).company = company.url;
  return { visited: true, url: company.url };
}

const FIRST_NAMES = [
  "Aman", "Rahul", "Rohit", "Amit", "Ankit", "Vikas", "Saurabh", "Deepak", "Nikhil", "Arjun",
  "Karan", "Varun", "Gaurav", "Manish", "Pankaj", "Sachin", "Vivek", "Abhishek", "Harsh", "Yash",
  "Priya", "Neha", "Pooja", "Anjali", "Sneha", "Kavya", "Riya", "Shreya", "Nisha", "Divya",
  "Aditi", "Megha", "Swati", "Ritu", "Komal", "Simran", "Tanvi", "Isha", "Payal", "Sakshi",
  "Mohit", "Ravi", "Sanjay", "Ajay", "Naveen", "Tarun", "Kunal", "Siddharth", "Aditya", "Prateek",
];
const LAST_NAMES = [
  "Sharma", "Gupta", "Verma", "Singh", "Kumar", "Agarwal", "Jain", "Mehta", "Patel", "Shah",
  "Yadav", "Mishra", "Pandey", "Tiwari", "Saxena", "Chauhan", "Rathore", "Bansal", "Goyal", "Mittal",
  "Joshi", "Malhotra", "Kapoor", "Arora", "Chopra", "Bhatia", "Soni", "Rawat", "Negi", "Thakur",
  "Reddy", "Nair", "Iyer", "Menon", "Rao", "Das", "Bose", "Ghosh", "Sen", "Dutta",
];

export function normalizeQuery(query) {
  return String(query || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Full-name shaped queries that this profile has never typed, and no other profile typed
// today according to the local shared-day file.
export function pickSearchQuery(state, shared = null, rng = Math.random) {
  const used = new Set([...(state.searchQueries || []), ...(shared?.day?.queries || [])].map(normalizeQuery));
  for (let i = 0; i < 400; i += 1) {
    const query = `${FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]}`;
    if (!used.has(normalizeQuery(query))) return query;
  }
  for (const first of FIRST_NAMES) for (const last of LAST_NAMES) {
    const query = `${first} ${last}`;
    if (!used.has(normalizeQuery(query))) return query;
  }
  return null;
}

export function rememberQuery(state, query, shared = null, persist = saveState) {
  state.searchQueries ||= [];
  state.searchQueries.push(normalizeQuery(query));
  persist(state);
  if (shared) {
    shared.day.queries.push(normalizeQuery(query));
    try { shared.save(); } catch { /* per-profile dedupe still holds */ }
  }
}

// Picks one of the first few results; the first is not favored heavily.
export function pickResultIndex(count, rng = Math.random) {
  const weights = [0.28, 0.26, 0.2, 0.15, 0.11].slice(0, Math.max(1, Math.min(count, 5)));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

// Finds the header search input. If only the search icon is visible it is pressed once per
// look; a missing box gets one more look after a pause.
async function locateSearchInput(page, pause) {
  for (let look = 0; look < 2; look += 1) {
    let box = await profileDom(page, "searchBox");
    if (box?.kind === "opener") {
      if (await clickLinkOnce(page, box, { pause, probe: "probeSearchBox" })) {
        await pause(randomInt(600, 1_200));
        box = await profileDom(page, "searchBox");
      }
    }
    if (box?.kind === "input") return box;
    log.info("LinkedIn header search box is not visible; looking for the search control again.", { look, found: box?.kind || null });
    await pause(randomInt(1_200, 2_200));
  }
  return null;
}

async function typeQuery(page, query, pause) {
  const box = await locateSearchInput(page, pause);
  if (box?.kind !== "input") return false;
  await page.mouse.move(box.x, box.y, { steps: randomInt(8, 16) });
  await pause(randomInt(250, 700));
  if (!(await profileDom(page, "probeSearchBox", box))) {
    log.warn("Header search box hit check failed; not clicking.", await profileDom(page, "searchDiagnostics", box).catch(() => ({})));
    return false;
  }
  await page.mouse.click(box.x, box.y, { delay: randomInt(50, 110) });
  await pause(randomInt(300, 700));
  if (!(await profileDom(page, "searchFocused"))) {
    await pause(randomInt(500, 900));
    if (!(await profileDom(page, "searchFocused"))) {
      log.warn("Header search box did not take focus after the click.", await profileDom(page, "searchDiagnostics", box).catch(() => ({})));
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
  }
  if (!(await clearSearchInput(page, pause))) {
    log.warn("Header search box did not empty; not typing a query into leftover text.", { value: await profileDom(page, "searchValue").catch(() => null) });
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  for (const [index, ch] of [...query].entries()) {
    await page.keyboard.type(ch, { delay: randomInt(40, 110) });
    await pause(randomInt(50, 200));
    // LinkedIn can restore the previous query into the box on focus; stop at the first sign.
    if (index === 0 && (await profileDom(page, "searchValue")) !== ch) {
      log.warn("Header search box refilled with old text while typing; not appending a second query.", { value: await profileDom(page, "searchValue").catch(() => null) });
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
  }
  await pause(randomInt(400, 1_100));
  const value = await profileDom(page, "searchValue");
  if (normalizeQuery(value) !== normalizeQuery(query)) {
    log.warn("Header search box does not hold exactly the query; not submitting.", { query, value });
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await page.keyboard.press("Enter");
  return true;
}

// Empties the focused header box with End + Backspace (Meta+A is unreliable in Orbita), then,
// if text remains, selects the input node's text and presses Backspace once. Emptiness is
// read back from the DOM each time; the caller never types into a non-empty box.
async function clearSearchInput(page, pause) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = await profileDom(page, "searchValue");
    if (value === "") return true;
    if (typeof value !== "string") return false;
    await page.keyboard.press("End");
    for (let i = 0; i < value.length + 2; i += 1) {
      await page.keyboard.press("Backspace");
      await pause(randomInt(25, 70));
    }
    await pause(randomInt(150, 350));
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = await profileDom(page, "searchValue");
    if (value === "") return true;
    if (typeof value !== "string" || !(await profileDom(page, "selectSearchText").catch(() => false))) return false;
    await page.keyboard.press("Backspace");
    await pause(randomInt(150, 350));
  }
  return (await profileDom(page, "searchValue")) === "";
}

function resultsFor(page, query) {
  try {
    const url = new URL(page.url());
    return /^\/search\/results\//.test(url.pathname) && normalizeQuery(url.searchParams.get("keywords")) === normalizeQuery(query);
  } catch { return false; }
}

// After submit the typeahead can stay open over dimmed results. Escape once, then "See all
// results" once; the results are only used once the overlay is confirmed closed.
async function closeTypeahead(page, pause) {
  let state = await profileDom(page, "typeahead").catch(() => null);
  if (!state?.open) return true;
  log.info("Search typeahead is still open after submit; pressing Escape.", { panels: state.panels });
  await page.keyboard.press("Escape");
  await pause(randomInt(500, 900));
  state = await profileDom(page, "typeahead").catch(() => null);
  if (!state?.open) return true;
  if (state.seeAll && await clickLinkOnce(page, state.seeAll, { pause, probe: "probeSeeAll" })) {
    await pause(randomInt(1_200, 2_000));
    state = await profileDom(page, "typeahead").catch(() => null);
  }
  return !state?.open;
}

export async function runSearch(page, state, plan, { signal, onHeartbeat = () => {}, pause = sleep, rng = Math.random, shared = undefined, read = readProfilePage } = {}) {
  const result = { searched: false, query: null, visits: 0, attempted: 0, connections: 0, sent: [], accountBlock: null, reason: null };
  if (!plan?.search || plan.testRun || plan.connectionTrial || state.currentRun?.testRun || state.currentRun?.connectionTrial) return { ...result, reason: "Search not planned" };
  if (shared === undefined) { try { shared = loadSharedDay(); } catch { shared = null; } }
  if (onErrorPage(page) && !(await returnHome(page, { pause, onHeartbeat }))) return { ...result, reason: "Browser error page before search" };
  const query = pickSearchQuery(state, shared, rng);
  if (!query) return { ...result, reason: "No unused search query" };
  rememberQuery(state, query, shared);
  result.query = query;
  log.info("Searching LinkedIn for a person.", { query });
  let typed = false;
  try { typed = await typeQuery(page, query, pause); }
  catch (error) { log.warn("Typing into LinkedIn search failed.", { message: error.message }); }
  // Results are only reached through the header box. There is no URL fallback: a Puppeteer
  // goto is what the local proxy refuses. A missed search is skipped, never a pause. The
  // results URL must carry this query: a tab left on an older search does not count.
  const onPeople = (path) => /^\/search\/results\/people(?:\/|$)/.test(path);
  if (!typed) {
    log.info("Search box was not found, not empty, or not exactly the query; skipping search this session.", { typed });
    return { ...result, reason: "Search box not usable" };
  }
  if (!(await waitForPath(page, () => resultsFor(page, query), { pause, timeoutMs: 12_000, onHeartbeat }))) {
    const open = await profileDom(page, "typeahead").catch(() => null);
    if (open?.seeAll && await clickLinkOnce(page, open.seeAll, { pause, probe: "probeSeeAll" })) {
      log.info("Enter did not open results; pressed See all results once.");
      await waitForPath(page, () => resultsFor(page, query), { pause, timeoutMs: 10_000, onHeartbeat });
    }
  }
  if (!resultsFor(page, query)) {
    log.info("Search did not open results for this query; skipping search this session.", { url: safeHref(page) });
    await page.keyboard.press("Escape").catch(() => {});
    return { ...result, reason: "Search results did not open" };
  }
  log.info("Search results are open for exactly this query.", { query, url: safeHref(page) });
  onHeartbeat();
  if (!(await closeTypeahead(page, pause))) {
    log.warn("Search typeahead stayed open over the results; not clicking through it.", { url: safeHref(page) });
    return { ...result, reason: "Typeahead stayed open" };
  }
  let block = await inspectAccount(page);
  if (block) return { ...result, accountBlock: block };
  if (!onPeople(pathOf(page))) {
    // Capture first, click after: only a People control the capture found for these keywords
    // is pressed. Nothing else on the page is clicked and the People URL is never opened directly.
    const started = Date.now();
    const capture = await captureResults(page, pause, onHeartbeat);
    result.dump = writeResultsDump(capture, { query, waitedMs: Date.now() - started });
    if (!capture?.people) {
      log.info("Search results capture found no People control for this query; skipping search this session.", { url: safeHref(page), looks: capture?.looks });
      return { ...result, reason: "No People control in results capture" };
    }
    if (!(await clickLinkOnce(page, capture.people, { pause, probe: "probePeopleFilter" }))) {
      log.info("People filter was not clickable on the results page; skipping search this session.", { url: safeHref(page), where: capture.people.where, label: capture.people.label });
      return { ...result, reason: "People results did not open" };
    }
    log.info("Clicked the People control found by the results capture.", { where: capture.people.where, label: capture.people.label, href: capture.people.href });
    if (!(await waitForPath(page, onPeople, { pause, timeoutMs: 12_000, onHeartbeat }))) {
      log.info("People results did not open after the filter click; skipping search this session.", { url: safeHref(page) });
      return { ...result, reason: "People results did not open" };
    }
    log.info("Opened People results from the search filter.", { url: safeHref(page) });
  }
  result.searched = true;
  block = await inspectAccount(page);
  if (block) return { ...result, accountBlock: block };
  await pause(randomInt(2_000, 4_500));
  const people = (await profileDom(page, "peopleResults")).filter((p) => !alreadyVisited(state, p.url)).slice(0, 5);
  if (!people.length) return { ...result, reason: "No unvisited people in the first results" };
  const target = people[pickResultIndex(people.length, rng)];
  if (target.y < 150 || target.y > 720) {
    await wheel(page, target.y - 400);
    await pause(randomInt(600, 1_200));
    const again = (await profileDom(page, "peopleResults")).find((p) => p.url === target.url);
    if (!again) return { ...result, reason: "Chosen result moved" };
    Object.assign(target, again);
  }
  if ((await profileDom(page, "typeahead").catch(() => null))?.open) {
    log.warn("Search typeahead reopened before the result click; not clicking through it.");
    return { ...result, reason: "Typeahead open before result click" };
  }
  log.info("Opening one search result.", { query, name: target.name, url: target.url, index: people.indexOf(target), of: people.length });
  rememberVisit(state, target.url);
  if (!(await clickLinkOnce(page, target, { pause }))) return { ...result, reason: "Result link hit check failed" };
  if (!(await waitForPath(page, (path) => /^\/in\//.test(path), { pause, timeoutMs: 12_000 }))) {
    log.info("Profile did not open from search; skipping.", { url: safeHref(page) });
    return { ...result, reason: "Profile did not open from search", returned: await returnHome(page, { pause, onHeartbeat }) };
  }
  block = await inspectAccount(page);
  if (block) return { ...result, accountBlock: block };
  log.info("Reading a person profile opened from search.", { url: safeHref(page) });
  await read(page, { pause, signal, onHeartbeat });
  result.visits += 1;
  if (plan.searchConnect && (!plan.verify || verifyNeeds(state).connect)) {
    const connect = await profileConnect(page, state, { url: target.url, signal, pause, shared });
    result.attempted += connect.attempted;
    result.connections += connect.connections;
    result.sent.push(...connect.sent);
    if (connect.accountBlock) return { ...result, accountBlock: connect.accountBlock };
  }
  if (plan.searchCompany && (!plan.verify || verifyNeeds(state).company)) {
    const company = await visitCompanyFromProfile(page, state, { pause, signal, onHeartbeat, read, rng });
    if (company.accountBlock) return { ...result, accountBlock: company.accountBlock };
    if (company.visited) {
      result.visits += 1;
      result.companyVisits = (result.companyVisits || 0) + 1;
    }
  }
  result.returned = await returnHome(page, { pause, onHeartbeat });
  return result;
}
