// Only matched against open dialogs, alerts, and toasts; post text in the feed body quotes it too.
export const INVITE_LIMIT_RE = /weekly invitation limit|reached.{0,50}invitation limit|too many invitations|invitation limit/i;

const RESTRICTION_RE = /account (?:has been |is )?(?:temporarily |permanently )?restricted|access to your account has been restricted/i;
const CHALLENGE_RE = /verify you.?re a real person|unusual activity|security checkpoint|enter the code/i;
const LOGIN_TEXT_RE = /sign in to linkedin|join linkedin|agree & join/i;
// linkedin.com/hp is the logged-out home page; a signed-in browser is sent to /feed/.
const LOGGED_OUT_HOME_RE = /^\/hp(?:\/|$)/i;

// `overlayText` comes only from dialogs, alerts, and toasts. `bodyText` is only supplied when
// the page has no LinkedIn nav (a bare interstitial), so posts, headlines, and search results
// that quote "unusual activity" or "enter the code" never reach these patterns.
export function classifyAccount(url, overlayText = "", chromePresent = false, bodyText = "") {
  // A chrome-error page is a failed load through the local proxy, not an account state. The
  // step that navigated handles it (Home click, reload); it must never pause the profile.
  if (/^chrome-error:/i.test(String(url || ""))) return null;
  let path;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.linkedin.com" && parsed.hostname !== "linkedin.com") return { kind: "unexpected_page", reason: "Browser is outside LinkedIn" };
    path = parsed.pathname;
  } catch { return { kind: "unexpected_page", reason: "Invalid page URL" }; }
  if (/checkpoint|challenge|captcha/i.test(path)) return { kind: "challenge", reason: "LinkedIn security challenge" };
  const bare = chromePresent ? "" : bodyText;
  if (RESTRICTION_RE.test(overlayText) || RESTRICTION_RE.test(bare)) return { kind: "restriction", reason: "LinkedIn account restriction" };
  if (CHALLENGE_RE.test(overlayText)) return { kind: "challenge", reason: "LinkedIn requests identity verification" };
  if (/authwall|\/login|\/signup|\/uas\//i.test(path) || LOGGED_OUT_HOME_RE.test(path)) return { kind: "login", reason: "LinkedIn login required" };
  if (!chromePresent && (LOGIN_TEXT_RE.test(overlayText) || LOGIN_TEXT_RE.test(bare))) return { kind: "login", reason: "LinkedIn login required" };
  return null;
}

export function accountSnapshotWorld() {
  const overlaySelector = '[role="dialog"], dialog[open], [role="alertdialog"], [role="alert"], [aria-live="assertive"], .artdeco-toast-item, [data-test-artdeco-toast-item-type]';
  const inContent = "[data-testid='mainFeed'], [componentkey^='update-card'], [data-urn], article, .search-results-container, [data-view-name*='search-entity']";
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const overlays = [...document.querySelectorAll(overlaySelector)]
    .filter((el) => !el.closest(inContent))
    .map((el) => text(el).slice(0, 600))
    .filter(Boolean);
  const chromePresent = Boolean(
    document.querySelector('[data-testid="mainFeed"], [componentkey*="container-update-list"], [componentkey^="update-card"], nav.global-nav, #global-nav')
    || [...document.querySelectorAll("header a[href], nav a[href]")].some((a) => /\/(feed|mynetwork|jobs|messaging|notifications)\b/.test(a.getAttribute("href") || "")),
  );
  return { overlays, chromePresent, bodyText: chromePresent || !document.body ? "" : text(document.body).slice(0, 3000) };
}

export async function inspectAccount(page) {
  const snapshot = await page.evaluate(accountSnapshotWorld);
  const overlays = Array.isArray(snapshot?.overlays) ? snapshot.overlays : [snapshot?.text || ""];
  // An invitation-limit notice is an invite hold (recorded by the caller), never a pause.
  const overlayText = overlays.filter((line) => !INVITE_LIMIT_RE.test(line)).join("\n");
  const chromePresent = snapshot?.chromePresent ?? Boolean(snapshot?.feedPresent);
  return classifyAccount(page.url(), overlayText, chromePresent, snapshot?.bodyText || "");
}

export function pauseForAccount(state, block, now = new Date()) {
  state.pause = {
    ...block, at: now.toISOString(),
    cooldownUntil: ["challenge", "restriction"].includes(block.kind) ? new Date(now.getTime() + 48 * 3600_000).toISOString() : null,
  };
}

// An account wall read from a URL alone (no frame needed): login, authwall, signup, the
// logged-out /hp home, or a checkpoint. Non-LinkedIn and ordinary LinkedIn pages return null.
export function accountBlockFromUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { return null; }
  if (parsed.hostname !== "www.linkedin.com" && parsed.hostname !== "linkedin.com") return null;
  const block = classifyAccount(parsed.href, "", true, "");
  return block && ["login", "challenge"].includes(block.kind) ? block : null;
}

// Every URL the browser reports: the working page's cached URL and each page target's URL.
// Target listings keep working after the page's frame has detached.
export async function observedAccountBlock(browser, page = null) {
  const urls = [];
  try { if (typeof page?.url === "function") urls.push(page.url()); } catch { /* detached */ }
  try {
    const targets = typeof browser?.targets === "function" ? await browser.targets() : [];
    for (const target of targets || []) {
      try { if (!target.type || target.type() === "page") urls.push(target.url()); } catch { /* gone */ }
    }
  } catch { /* browser gone */ }
  try {
    const pages = typeof browser?.pages === "function" ? await browser.pages() : [];
    for (const tab of pages || []) {
      try { urls.push(tab.url()); } catch { /* detached */ }
    }
  } catch { /* browser gone */ }
  for (const url of urls) {
    const block = accountBlockFromUrl(url);
    if (block) return { ...block, url };
  }
  return null;
}
