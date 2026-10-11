// One time budget for the whole session (feed + My Network + the linger after the last
// invite), measured from the first feed action. Browser start and stop are not included.
// Grow's share is reserved from the same total, so the feed is shortened to make room and
// invitations that do not fit at human pacing are not sent.

export const GROW_OPEN_MS = 20_000; // navigate to Grow, wait for cards to paint, settle
export const INVITE_WORK_MS = 15_000; // card dwell, press, and confirmation checks
export const FIRST_INVITE_MS = 25_000; // warm-up scrolls, card dwell, press, and checks
export const INVITE_STEP_MS = 55_000; // each later invite: the human gap, scrolls, and the press
export const LINGER_RESERVE_MS = 45_000; // time kept for staying on LinkedIn after the last invite
export const LINGER_FLOOR_MS = 20_000; // never close sooner than this after an invite
export const BUDGET_SLACK_MS = 30_000; // allowed overrun from the last in-flight action
export const FEED_OVERRUN_MS = 20_000; // the feed's last dwell or video runs past its end time
export const END_CUSHION_MS = 10_000; // the linger ends this much before the budget, for shutdown
const MIN_FEED_MS = 120_000;
const MIN_FEED_SHARE = 0.5;

export function planSessionBudget({ sessionMs, inviteCount = 0, order = ["feed"] } = {}) {
  const totalMs = Math.max(0, Math.round(sessionMs || 0));
  const wantsGrow = order.includes("grow") && inviteCount > 0;
  if (!wantsGrow) return { totalMs, feedMs: totalMs, growMs: 0, inviteCount: 0, requestedInvites: inviteCount, trimmed: inviteCount > 0 };
  const feedFloor = Math.max(MIN_FEED_MS, Math.round(totalMs * MIN_FEED_SHARE));
  const growRoom = Math.max(0, totalMs - feedFloor);
  const fixed = FEED_OVERRUN_MS + GROW_OPEN_MS + FIRST_INVITE_MS + LINGER_RESERVE_MS;
  const affordable = growRoom < fixed ? 0 : 1 + Math.floor((growRoom - fixed) / INVITE_STEP_MS);
  const invites = Math.min(inviteCount, affordable);
  if (invites <= 0) return { totalMs, feedMs: totalMs, growMs: 0, inviteCount: 0, requestedInvites: inviteCount, trimmed: true };
  const growMs = growShareMs(invites);
  return { totalMs, feedMs: totalMs - growMs, growMs, inviteCount: invites, requestedInvites: inviteCount, trimmed: invites < inviteCount };
}

export function growShareMs(invites) {
  return invites > 0 ? FEED_OVERRUN_MS + GROW_OPEN_MS + FIRST_INVITE_MS + (invites - 1) * INVITE_STEP_MS + LINGER_RESERVE_MS : 0;
}

// Time My Network may use from now, keeping the linger reserve for after the last invite.
export function growTimeLeft(sessionEndsAt, now = Date.now()) {
  return Math.max(0, sessionEndsAt - now - LINGER_RESERVE_MS);
}

// The post-invite linger fits the remaining budget, with a short floor so the browser never
// closes seconds after an invite.
export function boundedLingerMs(sampledMs, sessionEndsAt, now = Date.now()) {
  if (!(sampledMs > 0)) return 0;
  return Math.min(sampledMs, Math.max(LINGER_FLOOR_MS, sessionEndsAt - END_CUSHION_MS - now));
}
