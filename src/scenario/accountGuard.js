export function classifyAccount(url, text = "", feedPresent = false) {
  let path;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.linkedin.com" && parsed.hostname !== "linkedin.com") return { kind: "unexpected_page", reason: "Browser is outside LinkedIn" };
    path = parsed.pathname;
  } catch { return { kind: "unexpected_page", reason: "Invalid page URL" }; }
  if (/checkpoint|challenge|captcha/i.test(path)) return { kind: "challenge", reason: "LinkedIn security challenge" };
  if (/account (?:has been |is )?(?:temporarily |permanently )?restricted|access to your account has been restricted/i.test(text)) return { kind: "restriction", reason: "LinkedIn account restriction" };
  if (/verify you.?re a real person|unusual activity|security checkpoint|enter the code/i.test(text)) return { kind: "challenge", reason: "LinkedIn requests identity verification" };
  if (/weekly invitation limit|reached.{0,50}invitation limit|too many invitations/i.test(text)) return { kind: "invitation_limit", reason: "LinkedIn invitation limit reached" };
  if (/authwall|\/login|\/signup|\/uas\//i.test(path)) return { kind: "login", reason: "LinkedIn login required" };
  if (!feedPresent && /sign in to linkedin|join linkedin|agree & join/i.test(text)) return { kind: "login", reason: "LinkedIn login required" };
  return null;
}

export async function inspectAccount(page) {
  const snapshot = await page.evaluate(() => ({
    text: (document.querySelector('[role="dialog"]')?.innerText || "") + "\n" + (document.body?.innerText || "").slice(0, 4000),
    feedPresent: Boolean(document.querySelector('[data-testid="mainFeed"], [componentkey*="container-update-list"], [componentkey^="update-card"], nav.global-nav')),
  }));
  return classifyAccount(page.url(), snapshot.text, snapshot.feedPresent);
}

export function pauseForAccount(state, block, now = new Date()) {
  state.pause = {
    ...block, at: now.toISOString(),
    cooldownUntil: ["challenge", "restriction"].includes(block.kind) ? new Date(now.getTime() + 48 * 3600_000).toISOString() : null,
  };
}
