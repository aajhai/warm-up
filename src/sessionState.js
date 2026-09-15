import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { writeJsonAtomic } from "./util/files.js";
import { dataDir } from "./util/paths.js";

export { dataDir };

export function emptyState(profile = config) {
  return {
    schemaVersion: 2, profileName: profile.profileName, profileId: profile.profileId,
    daily: {}, weekly: {}, actions: [], history: [], currentRun: null,
    lastSession: null, pause: null, optimizerNotes: [], skippedWindows: {}, windows: {},
  };
}

export function scopedStatePath(profile = config) {
  const key = profile.profileId || profile.profileName?.trim().toLowerCase().replace(/\s+/g, "-");
  if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("A valid profile ID or name is required for state storage.");
  return join(dataDir, `state-${key}.json`);
}

export function loadState(profile = config) {
  const path = scopedStatePath(profile);
  if (!existsSync(path)) return emptyState(profile);
  let saved;
  try { saved = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Cannot read profile state at ${path}. Refusing to reset activity budgets.`); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid profile state document.");
  if (saved.schemaVersion !== undefined && saved.schemaVersion !== 2) throw new Error("Unsupported profile state version; migration is required.");
  if (saved.schemaVersion === 2 && ["daily", "weekly", "actions", "windows"].some((key) => saved[key] === undefined)) throw new Error("Incomplete profile state. Refusing to reset activity budgets.");
  const state = { ...emptyState(profile), ...saved };
  for (const key of ["daily", "weekly", "windows", "skippedWindows"]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) throw new Error(`Invalid ${key} in profile state.`);
  }
  for (const key of ["actions", "history", "optimizerNotes"]) {
    if (!Array.isArray(state[key])) throw new Error(`Invalid ${key} in profile state.`);
  }
  for (const day of Object.values(state.daily)) {
    for (const key of ["likes", "sessions", "postsSeen", "aborted"]) {
      if (!Number.isInteger(day[key]) || day[key] < 0) throw new Error(`Invalid daily ${key} count. Refusing to reset activity budgets.`);
    }
    for (const key of ["connections", "testRuns", "testFailures"]) {
      if (day[key] !== undefined && (!Number.isInteger(day[key]) || day[key] < 0)) throw new Error(`Invalid daily ${key} count.`);
    }
  }
  const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  for (const budget of Object.values(state.weekly)) {
    if (!budget || ["cap", "used", "confirmed"].some((key) => !Number.isInteger(budget[key]) || budget[key] < 0) || budget.cap > 100 || budget.confirmed > budget.used) throw new Error("Invalid weekly connection budget. Refusing to reset it.");
  }
  for (const action of state.actions) {
    if (!action || !["like", "connect"].includes(action.kind) || !["reserved", "confirmed", "unconfirmed"].includes(action.status) || !action.id || !action.runId || !action.key || !validDate(action.at)) throw new Error("Invalid saved action. Manual state review is required.");
  }
  if (state.currentRun && (!state.currentRun.id || !validDate(state.currentRun.at) || !/^\d{4}-\d{2}-\d{2}$/.test(state.currentRun.dayKey) || typeof state.currentRun.testRun !== "boolean")) throw new Error("Invalid unfinished run. Manual state review is required.");
  if (state.pause && (typeof state.pause !== "object" || !state.pause.reason || (state.pause.cooldownUntil && !validDate(state.pause.cooldownUntil)))) throw new Error("Invalid profile pause. Manual state review is required.");
  if (!saved.schemaVersion && saved.lastSession?.checkpoint) {
    state.pause = { kind: "challenge", reason: "Previous account challenge requires manual review", at: saved.lastSession.at, cooldownUntil: new Date(new Date(saved.lastSession.at).getTime() + 48 * 3600_000).toISOString() };
  }
  if (profile.profileId && state.profileId && profile.profileId !== state.profileId) throw new Error("State belongs to another profile.");
  state.schemaVersion = 2;
  return state;
}

export function saveState(state, profile = config) {
  writeJsonAtomic(scopedStatePath(profile), { ...state, schemaVersion: 2, profileName: profile.profileName, profileId: profile.profileId });
}

export function getDayStats(state, dateKey) {
  if (!state.daily[dateKey]) state.daily[dateKey] = { likes: 0, sessions: 0, postsSeen: 0, aborted: 0, testRuns: 0, connections: 0 };
  const day = state.daily[dateKey];
  day.connections ??= 0;
  day.testRuns ??= 0;
  return day;
}
