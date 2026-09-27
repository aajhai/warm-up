import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { notify, redact } from "./notifications/slack.js";

// Under `node --test` the repo log is never the default; fixtures must not mix with live runs.
export const logsDir = process.env.WARMUP_LOG_DIR
  || (process.env.NODE_TEST_CONTEXT ? join(tmpdir(), `warmup-test-logs-${process.pid}`) : join(dirname(fileURLToPath(import.meta.url)), "..", "logs"));
mkdirSync(logsDir, { recursive: true });
const logFile = join(logsDir, "warmup.jsonl");

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const warningCounts = {};
export function getWarningCounts() { return { ...warningCounts }; }

function stamp() {
  return new Date().toISOString();
}

function write(level, role, message, extra) {
  message = redact(message);
  if (extra) extra = JSON.parse(redact(JSON.stringify(extra)));
  const line = extra
    ? `${stamp()} [${level}] [${role}] ${message} ${JSON.stringify(extra)}`
    : `${stamp()} [${level}] [${role}] ${message}`;
  const printer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  printer(line);
  try {
    appendFileSync(logFile, `${JSON.stringify({ at: stamp(), level, role, message, extra: extra || null })}\n`);
  } catch {
    /* console already has it */
  }
  if (level === "error") {
    try { notify("error", message, { component: role, ...(extra || {}) }); }
    catch { console.error("Could not persist Slack error notification."); }
  }
  if (level === "warn" && /fail|did not|refus|unexpected|stalled/i.test(message)) {
    const key = `${role}: ${message}`;
    warningCounts[key] = (warningCounts[key] || 0) + 1;
    if (warningCounts[key] === 1) {
      try { notify("warning", message, { component: role, ...(extra || {}) }); }
      catch { console.error("Could not persist Slack warning notification."); }
    }
  }
}

export function createLogger(role) {
  return {
    debug: (message, extra) => write("debug", role, message, extra),
    info: (message, extra) => write("info", role, message, extra),
    warn: (message, extra) => write("warn", role, message, extra),
    error: (message, extra) => write("error", role, message, extra),
  };
}

export { levels, logFile };
