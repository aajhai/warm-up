import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { writeJsonAtomic } from "./util/files.js";
import { dataDir } from "./util/paths.js";
import { addIstDays, fromIst, istNow } from "./util/time.js";
import { utcWeekKey as weekStartKey } from "./activity.js";

const WEEK_MS = 7 * 86400_000;
export const SHARED_STILL_OFFERED_LIMIT = 3;

export function nextWeeklyReset(now = new Date()) {
  return new Date(new Date(`${weekStartKey(now)}T00:00:00.000Z`).getTime() + WEEK_MS);
}

export function nextIstMidnight(now = new Date()) {
  const next = addIstDays(istNow(now), 1);
  return fromIst(next.year, next.month, next.day, 0, 0);
}

// Cross-profile facts for one IST day, kept in a local file so a sequential queue can
// share them without a service. A missing or unreadable file only loses this extra caution.
export function sharedDayPath() {
  return join(dataDir, "shared-day.json");
}

export function loadSharedDay(now = new Date(), path = sharedDayPath()) {
  const dateKey = istNow(now).dateKey;
  let doc = { days: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed.days === "object" && !Array.isArray(parsed.days)) doc = parsed;
    } catch { /* treat as empty */ }
  }
  for (const key of Object.keys(doc.days)) if (key < istNow(new Date(now.getTime() - 3 * 86400_000)).dateKey) delete doc.days[key];
  const day = doc.days[dateKey] ||= { queries: [], stillOffered: [] };
  day.queries = Array.isArray(day.queries) ? day.queries.filter((q) => typeof q === "string") : [];
  day.stillOffered = Array.isArray(day.stillOffered) ? day.stillOffered.filter((p) => typeof p === "string") : [];
  return { doc, day, dateKey, save: () => writeJsonAtomic(path, doc) };
}

function profileKey(profile = config) {
  return String(profile.profileId || profile.profileName || "unknown");
}

// Returns a reason string when this profile must not send invitations right now.
export function inviteHoldReason(state, now = new Date(), shared = null) {
  if (state.inviteHold && now.getTime() < new Date(state.inviteHold.until).getTime()) {
    return `Invites held until ${state.inviteHold.until}: ${state.inviteHold.reason}`;
  }
  if (shared && new Set(shared.day.stillOffered).size >= SHARED_STILL_OFFERED_LIMIT) {
    return `${SHARED_STILL_OFFERED_LIMIT} profiles saw Connect still offered after reload today; skipping invites for every profile until IST midnight`;
  }
  return null;
}

function setHold(state, until, kind, reason, now) {
  const current = state.inviteHold && new Date(state.inviteHold.until).getTime() > now.getTime() ? new Date(state.inviteHold.until) : null;
  if (current && current >= until) return state.inviteHold;
  state.inviteHold = { kind, reason, at: now.toISOString(), until: until.toISOString() };
  return state.inviteHold;
}

export function recordStillOffered(state, { now = new Date(), shared = null, profile = config, url = null } = {}) {
  const week = weekStartKey(now);
  state.inviteSignals = [...(state.inviteSignals || []), { kind: "still_offered", at: now.toISOString(), week, dayKey: istNow(now).dateKey, url }].slice(-50);
  const thisWeek = state.inviteSignals.filter((s) => s.kind === "still_offered" && s.week === week).length;
  const hold = thisWeek >= 2
    ? setHold(state, nextWeeklyReset(now), "still_offered_week", "Connect was still offered after reload twice this UTC week", now)
    : setHold(state, nextIstMidnight(now), "still_offered_day", "Connect was still offered after reload", now);
  if (shared) {
    const key = profileKey(profile);
    if (!shared.day.stillOffered.includes(key)) shared.day.stillOffered.push(key);
    try { shared.save(); } catch { /* the per-profile hold still applies */ }
  }
  return hold;
}

export function recordInviteLimit(state, { now = new Date(), text = "" } = {}) {
  state.inviteSignals = [...(state.inviteSignals || []), { kind: "invitation_limit", at: now.toISOString(), week: weekStartKey(now), dayKey: istNow(now).dateKey }].slice(-50);
  return setHold(state, nextWeeklyReset(now), "invitation_limit", `LinkedIn invitation limit notice${text ? `: ${text.slice(0, 120)}` : ""}`, now);
}
