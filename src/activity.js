import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getDayStats, saveState } from "./sessionState.js";
import { istNow } from "./util/time.js";
import { randomInt } from "./util/random.js";

const WEEK_MS = 7 * 86400_000;

export function utcWeekKey(now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function weeklyBudget(state, now = new Date(), choose = randomInt) {
  const week = utcWeekKey(now);
  if (!state.enrolledAt) state.enrolledAt = now.toISOString();
  const enrolled = new Date(state.enrolledAt).getTime();
  if (!Number.isFinite(enrolled) || enrolled > now.getTime()) throw new Error("Invalid warm-up enrollment date.");
  const weekStart = new Date(`${week}T00:00:00.000Z`).getTime();
  // Only completed seven-day periods at the start of the budget week advance the stage.
  const stage = Math.min(config.connectionWeeklyRanges.length - 1, Math.max(0, Math.floor((weekStart - enrolled) / WEEK_MS)));
  if (!state.weekly[week]) {
    const [min, max] = config.connectionWeeklyRanges[stage];
    state.weekly[week] = { cap: choose(min, max), used: 0, confirmed: 0, stage: stage + 1 };
  }
  const budget = state.weekly[week];
  if (!Number.isInteger(budget.cap) || budget.cap < 0 || budget.cap > 100 || !Number.isInteger(budget.used) || budget.used < 0) throw new Error("Invalid connection budget. Refusing to reset it.");
  return { week, ...budget, remaining: Math.max(0, budget.cap - budget.used), dailyCap: Math.ceil(budget.cap / 7) };
}

export function actionKey(kind, target) {
  return createHash("sha256").update(`${kind}:${target}`).digest("hex");
}

export function alreadyAttempted(state, kind, target) {
  const key = actionKey(kind, target);
  return state.actions.some((action) => action.key === key);
}

export function reserveAction(state, kind, target, { now = new Date(), persist = saveState, limit } = {}) {
  if (!state.currentRun || state.currentRun.testRun || state.pause) throw new Error("Actions require an active, unpaused production run.");
  if (!["like", "connect"].includes(kind)) throw new Error("Unsupported action.");
  if (!target || alreadyAttempted(state, kind, target)) return null;
  const usedInRun = state.actions.filter((a) => a.runId === state.currentRun.id && a.kind === kind).length;
  if (!Number.isInteger(limit) || limit <= 0 || usedInRun >= limit) return null;
  const local = istNow(now);
  if (!config.forceOutsideHours && (local.hour < config.workStartHour || local.hour >= config.workEndHour)) return null;
  const dayKey = local.dateKey;
  const day = getDayStats(state, dayKey);
  let week;
  if (kind === "like") {
    if (!config.likesEnabled || day.likes >= config.dailyLikeBudget) return null;
    day.likes += 1;
  } else {
    if (!config.connectionsEnabled) return null;
    const budget = weeklyBudget(state, now);
    if (budget.remaining <= 0 || day.connections >= budget.dailyCap) return null;
    week = budget.week;
    state.weekly[week].used += 1;
    day.connections += 1;
  }
  const action = { id: randomUUID(), runId: state.currentRun.id, key: actionKey(kind, target), kind, dayKey, week, at: now.toISOString(), status: "reserved" };
  state.actions.push(action);
  // Persist BEFORE dispatching the click. Uncertain outcomes continue to consume budget.
  persist(state);
  return action.id;
}

export function finishAction(state, id, confirmed, persist = saveState) {
  const action = state.actions.find((item) => item.id === id);
  if (!action || action.status !== "reserved") throw new Error("Action reservation is missing or already finalized.");
  action.status = confirmed ? "confirmed" : "unconfirmed";
  action.finishedAt = new Date().toISOString();
  if (confirmed && action.kind === "connect") state.weekly[action.week].confirmed += 1;
  persist(state);
}

export function beginRun(state, plan, now = new Date(), persist = saveState) {
  if (state.currentRun) throw new Error("Previous run is unfinished; recover it before starting another.");
  if (!plan.testRun) state.enrolledAt ||= now.toISOString();
  const dayKey = istNow(now).dateKey;
  const day = getDayStats(state, dayKey);
  if (plan.testRun) day.testRuns += 1;
  else day.sessions += 1;
  state.currentRun = { id: randomUUID(), at: now.toISOString(), dayKey, testRun: Boolean(plan.testRun), connectionTrial: Boolean(plan.connectionTrial) };
  persist(state);
  return state.currentRun;
}

export function recoverInterruptedRun(state, persist = saveState) {
  if (!state.currentRun) return false;
  const run = state.currentRun;
  if (state.actions.some((action) => action.runId === run.id && action.kind === "connect" && action.status !== "confirmed")) {
    state.pause ||= { kind: "uncertain_connection", reason: "Interrupted connection attempt requires invitation review", at: new Date().toISOString() };
  }
  const day = getDayStats(state, run.dayKey);
  if (run.testRun) day.testFailures = (day.testFailures || 0) + 1;
  else day.aborted += 1;
  state.history.push({ ...run, outcome: "interrupted", finishedAt: new Date().toISOString() });
  state.history = state.history.slice(-200);
  state.currentRun = null;
  persist(state);
  return true;
}
