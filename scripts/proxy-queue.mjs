// Picks the next warm-up profile so two runs never use the same proxy port in a row.
// The next profile always comes from a different port than the one that just opened a browser.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function completedSessionToday(state, today) {
  if (!state || !today) return false;
  const rows = [];
  if (state.lastSession) rows.push(state.lastSession);
  if (Array.isArray(state.history)) rows.push(...state.history);
  return rows.some((item) => {
    const day = item?.dateKey || item?.dayKey;
    return day === today && item.aborted === false && item.testRun !== true;
  });
}

// WARMUP_ONLY_IDS: comma- or space-separated GoLogin ids. Empty means no filter (null).
export function parseOnlyIds(value) {
  const ids = String(value || "").split(/[\s,]+/).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

export function proxyKey(port) {
  if (port == null) return "none";
  const text = String(port).trim();
  return text || "none";
}

export function parseQueue(text) {
  return String(text || "").split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const [id, name, port = ""] = line.split("\t");
    return { id, name, port };
  });
}

export function formatQueue(items) {
  if (!items.length) return "";
  return `${items.map((item) => `${item.id}\t${item.name}\t${item.port ?? ""}`).join("\n")}\n`;
}

// Among profiles whose port differs from the one that just ran, take the port that
// still has the most profiles left. That keeps a later same-port pair from becoming unavoidable.
export function pickNext(items, lastPort) {
  if (!items.length) return null;
  const last = lastPort == null || lastPort === "" || lastPort === "-" ? null : proxyKey(lastPort);
  const counts = new Map();
  for (const item of items) {
    const key = proxyKey(item.port);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const item of items) {
    const key = proxyKey(item.port);
    if (last != null && key === last) continue;
    const count = counts.get(key);
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

export function orderByProxy(items) {
  const remaining = items.map((item) => ({ ...item }));
  const ordered = [];
  let last = null;
  while (remaining.length) {
    const next = pickNext(remaining, last);
    if (!next) break;
    ordered.push(next);
    remaining.splice(remaining.findIndex((item) => item.id === next.id), 1);
    last = proxyKey(next.port);
  }
  return { ordered, deferred: remaining };
}

function main() {
  const [command, queueFile, lastPort] = process.argv.slice(2);
  if (command !== "pick" || !queueFile) {
    console.error("usage: node scripts/proxy-queue.mjs pick <queueFile> <lastPort|->");
    process.exit(1);
  }
  const items = parseQueue(readFileSync(queueFile, "utf8"));
  if (!items.length) process.exit(0);
  const next = pickNext(items, lastPort);
  if (!next) process.exit(2);
  writeFileSync(queueFile, formatQueue(items.filter((item) => item.id !== next.id)));
  process.stdout.write(`${next.id}\t${next.name}\t${next.port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
