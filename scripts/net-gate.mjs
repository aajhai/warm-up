// Exits 0 once api.gologin.com and the GoLogin desktop API both answer.
// Exits 3 after WARMUP_NET_WAIT_MIN minutes of waiting (default 15). Never starts a browser.
// Usage: node scripts/net-gate.mjs
import { waitForConnectivity } from "../src/util/connectivity.js";

const minutes = Number.parseFloat(process.env.WARMUP_NET_WAIT_MIN || "15");
const budgetMs = Math.max(0, Number.isFinite(minutes) ? minutes : 15) * 60_000;
const result = await waitForConnectivity({
  budgetMs,
  onWait: ({ attempt, waitMs, waitedMs, reason }) => {
    console.log(`net-gate: GoLogin not reachable (${reason}). Waiting ${Math.round(waitMs / 1000)}s before check ${attempt + 1}; waited ${Math.round(waitedMs / 1000)}s so far.`);
  },
});
if (result.ok) {
  if (result.waitedMs > 0) console.log(`net-gate: GoLogin reachable again after ${Math.round(result.waitedMs / 1000)}s.`);
  process.exit(0);
}
console.log(`net-gate: GoLogin still unreachable after ${Math.round(result.waitedMs / 60_000)} min (${result.reason}).`);
process.exit(3);
