import { sleep } from "./util/random.js";
import { addIstDays, fromIst, istNow } from "./util/time.js";

export const WINDOWS = [
  { id: "morning", startHour: 9, startMin: 8, endHour: 10, endMin: 25 },
  { id: "midday", startHour: 12, startMin: 45, endHour: 14, endMin: 5 },
  { id: "afternoon", startHour: 15, startMin: 20, endHour: 16, endMin: 38 },
];
export const LATE_GRACE_MS = 2 * 60_000;

export function nextRunAt(state, now = new Date(), random = Math.random) {
  if (state.pause) return null;
  let day = istNow(now);
  for (let offset = 0; offset < 8; offset += 1) {
    if (offset) day = addIstDays(day, 1);
    for (const win of WINDOWS) {
      const key = `${day.dateKey}:${win.id}`;
      const start = fromIst(day.year, day.month, day.day, win.startHour, win.startMin).getTime();
      const end = fromIst(day.year, day.month, day.day, win.endHour, win.endMin).getTime();
      let entry = state.windows[key];
      if (!entry) {
        if (end <= now.getTime() + 15_000) continue;
        const skipped = state.skippedWindows[key] ?? random() < 0.2;
        const lower = Math.max(start, now.getTime() + 15_000);
        entry = state.windows[key] = {
          status: skipped ? "skipped" : "scheduled",
          at: new Date(lower + Math.floor(random() * (end - lower))).toISOString(),
          end: new Date(end).toISOString(),
        };
      }
      if (entry.status !== "scheduled") continue;
      const at = new Date(entry.at);
      if (now.getTime() > Math.min(at.getTime() + LATE_GRACE_MS, end)) {
        entry.status = "missed";
        continue;
      }
      return { key, at, window: win.id, dateKey: day.dateKey };
    }
  }
  return null;
}

export function claimWindow(state, key, now = new Date()) {
  const entry = state.windows[key];
  if (!entry || entry.status !== "scheduled") return false;
  const at = new Date(entry.at).getTime();
  if (now.getTime() < at || now.getTime() > Math.min(at + LATE_GRACE_MS, new Date(entry.end).getTime())) return false;
  entry.status = "started";
  entry.startedAt = now.toISOString();
  return true;
}

export async function waitUntil(date, signal) {
  while (Date.now() < date.getTime()) {
    signal?.throwIfAborted();
    await sleep(Math.min(15_000, date.getTime() - Date.now()));
  }
}
