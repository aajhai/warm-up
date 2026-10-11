import { isNetworkOutage } from "./failures.js";

export const GOLOGIN_API_URL = "https://api.gologin.com";
export const GOLOGIN_LOCAL_URL = "http://127.0.0.1:36912";
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];

// Any HTTP answer means the host is reachable; only a failed request counts as down.
async function reachable(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel?.().catch?.(() => {});
    return { up: true, status: response.status };
  } catch (error) {
    const code = error?.cause?.code || error?.code || error?.name || "error";
    return { up: false, detail: `${code}: ${error?.cause?.message || error?.message || "request failed"}` };
  }
}

export async function probeConnectivity({ fetchImpl = fetch, apiUrl = GOLOGIN_API_URL, localUrl = GOLOGIN_LOCAL_URL, timeoutMs = 8_000 } = {}) {
  const [api, local] = await Promise.all([
    reachable(fetchImpl, apiUrl, timeoutMs),
    reachable(fetchImpl, localUrl, timeoutMs),
  ]);
  const down = [];
  if (!api.up) down.push(`GoLogin API ${api.detail}`);
  if (!local.up) down.push(`GoLogin local API ${local.detail}`);
  return { ok: api.up && local.up, api, local, reason: down.join("; ") || null };
}

export function backoffMs(attempt) {
  return BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)];
}

// Waits with backoff until both GoLogin endpoints answer. `budgetMs` counts the waits
// themselves, so time the Mac spends asleep does not use up the budget.
export async function waitForConnectivity({
  probe = probeConnectivity,
  budgetMs = 15 * 60_000,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWait = () => {},
} = {}) {
  let waited = 0;
  let last = await probe();
  for (let attempt = 0; !last.ok && waited < budgetMs; attempt += 1) {
    const ms = Math.min(backoffMs(attempt), budgetMs - waited);
    onWait({ attempt: attempt + 1, waitMs: ms, waitedMs: waited, reason: last.reason });
    await pause(ms);
    waited += ms;
    last = await probe();
  }
  return { ...last, waitedMs: waited };
}

export function outageError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.networkOutage = true;
  error.failureKind = "infra";
  return error;
}

export { isNetworkOutage };
