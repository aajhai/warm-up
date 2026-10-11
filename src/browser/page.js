import { infrastructureError } from "../util/failures.js";

// A missing first tab is a slow Orbita/proxy startup, not a reason to hammer
// browser.pages(). chrome-error and Gmail still count as tabs; navigation is separate.
export const INITIAL_TAB_ATTEMPTS = 4;
export const INITIAL_TAB_WAIT_MS = 8_000;

export function initialTabUrl(page) {
  try {
    const href = typeof page?.url === "function" ? page.url() : page?.url;
    return typeof href === "string" ? href : "";
  } catch {
    return "";
  }
}

export function isInitialTab(page) {
  const href = initialTabUrl(page);
  return Boolean(href) && href !== ":" && !/^about:blank$/i.test(href);
}

export async function waitForInitialTab(listPages, {
  attempts = INITIAL_TAB_ATTEMPTS,
  waitMs = INITIAL_TAB_WAIT_MS,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let listed = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pages = await listPages();
    // null means the debugger listing is not answering yet, which is common right after
    // start. Keep polling; giving up on the first null skipped the start-tab redirect.
    if (Array.isArray(pages)) {
      listed = true;
      const ready = pages.filter(isInitialTab);
      if (ready.length) return ready;
    }
    if (attempt < attempts) await pause(waitMs);
  }
  // A listing that never answered is left to the working-tab check instead of failing here.
  if (!listed) return null;
  throw infrastructureError("Profile opened with no tabs after waiting for the browser to create one. Proxy or browser startup failed; the LinkedIn account was not paused.");
}

export async function foregroundPage(page, { timeoutMs = 8_000 } = {}) {
  let cdp = null;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    // Detach immediately so a hung Target/Browser command cannot occupy the
    // page session and wedge later Runtime.callFunctionOn for protocolTimeout.
    cdp?.detach().catch(() => {});
    cdp = null;
  }, timeoutMs);

  try {
    cdp = await page.createCDPSession();
    try {
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
      // Local fullscreen Orbita can be on another macOS Space. Cloud Browser has
      // no desktop window, so these window-management commands may be unavailable.
      if (["fullscreen", "minimized"].includes(bounds.windowState)) {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
    } catch {
      // Headless/cloud targets still support bringToFront without window bounds.
    }
    await page.bringToFront();
  } catch {
    await page.bringToFront().catch(() => {});
  } finally {
    settled = true;
    clearTimeout(timer);
    await cdp?.detach().catch(() => {});
  }
}

// Puppeteer throws this when a CDP call uses a Frame that navigation already
// disposed. page.url() can still return the cached URL; evaluate cannot.
// A closed or swapped page target is the same condition seen from a different CDP call.
export function isDetachedFrameError(error) {
  const message = error?.message || String(error || "");
  return /detached Frame|Navigating frame was detached|Execution context was destroyed|Execution context is not available|Target closed|Session closed\. Most likely the page has been closed|No target with given id/i.test(message);
}

export function readPageUrl(page) {
  try {
    return typeof page?.url === "function" ? page.url() : null;
  } catch (error) {
    if (isDetachedFrameError(error)) return null;
    throw error;
  }
}

export function browserOf(page) {
  if (!page) return null;
  try {
    return typeof page.browser === "function" ? page.browser() : page.browser || null;
  } catch (error) {
    if (isDetachedFrameError(error)) return null;
    throw error;
  }
}

function linkedInHost(url) {
  try {
    const host = new URL(url).hostname;
    return host === "linkedin.com" || host === "www.linkedin.com";
  } catch {
    return false;
  }
}

// A cached URL is not proof the frame can run script. Probe with a short race so a
// wedged target cannot stall every navigation retry for the full protocol timeout.
export async function frameIsUsable(page, timeoutMs = 4_000) {
  if (typeof page?.evaluate !== "function") return readPageUrl(page) != null;
  let timer;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
  const probed = Promise.resolve()
    .then(() => page.evaluate(() => true))
    .then(() => ({ ok: true }))
    .catch((error) => ({ error }));
  try {
    const winner = await Promise.race([probed, timed]);
    if (winner?.timeout) return false;
    if (winner?.error) {
      if (isDetachedFrameError(winner.error)) return false;
      throw winner.error;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Prefer a live /feed/ tab. A page whose main frame is already detached is skipped
// so the caller can retry navigation on a frame that still accepts CDP.
export async function resolveLiveLinkedInPage(browser) {
  if (!browser || typeof browser.pages !== "function") return null;
  let pages = [];
  try {
    pages = await browser.pages();
  } catch (error) {
    if (isDetachedFrameError(error) || /Connection closed|Protocol error/i.test(error?.message || "")) return null;
    throw error;
  }
  const usable = [];
  for (const page of pages) {
    if (restoredTabs.has(page)) continue;
    const url = readPageUrl(page);
    if (!url || !linkedInHost(url)) continue;
    let usableFrame = false;
    try { usableFrame = await frameIsUsable(page); }
    catch (error) { if (!/Protocol error|Connection closed/i.test(error?.message || "")) throw error; }
    if (!usableFrame) continue;
    let path = "/";
    try { path = new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { /* rank last */ }
    usable.push({ page, feed: path === "/feed" });
  }
  return usable.find((item) => item.feed)?.page || usable[0]?.page || null;
}

// A renderer swap replaces the tab's target a moment after the old one closes.
export const LIVE_PAGE_ATTEMPTS = 4;
export const LIVE_PAGE_WAIT_MS = 1_500;

export async function waitForLiveLinkedInPage(browser, {
  attempts = LIVE_PAGE_ATTEMPTS,
  waitMs = LIVE_PAGE_WAIT_MS,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const live = await resolveLiveLinkedInPage(browser);
    if (live) return live;
    if (attempt < attempts) await pause(waitMs);
  }
  return null;
}

// Tabs that were already open when the session picked its working tab (GoLogin restores the
// previous session's tabs). They are never picked, adopted, or given input.
const restoredTabs = new WeakSet();

export function markRestoredTabs(pages, working) {
  for (const tab of pages || []) if (tab && tab !== working) restoredTabs.add(tab);
}

export function isRestoredTab(page) {
  return Boolean(page) && restoredTabs.has(page);
}

// Sessions never open tabs. A tab opened by one of ours (a target=_blank link) is closed.
export function guardNewTabs(browser, { log = null } = {}) {
  if (typeof browser?.on !== "function") return () => {};
  const onCreated = async (target) => {
    if (target?.type?.() !== "page" || !target.opener?.()) return;
    log?.warn("Closing a tab that our input opened; sessions never open new tabs.", { url: target.url?.() });
    const tab = await target.page?.().catch(() => null);
    await tab?.close?.().catch(() => {});
  };
  browser.on("targetcreated", onCreated);
  return () => browser.off?.("targetcreated", onCreated);
}
