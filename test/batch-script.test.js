import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

// A throwaway copy of the batch script with every external command stubbed. There is no
// token and no node_modules, so stop_profile cannot reach GoLogin.
function batchTree({ queue, outcomes, gate = "pass", paused = [] }) {
  const root = mkdtempSync(join(tmpdir(), "warmup-batch-"));
  for (const dir of ["scripts", "bin", "data", "outcomes"]) mkdirSync(join(root, dir));
  copyFileSync(join(repo, "scripts/run-available-folder.sh"), join(root, "scripts/run-available-folder.sh"));
  copyFileSync(join(repo, "scripts/proxy-queue.mjs"), join(root, "scripts/proxy-queue.mjs"));
  writeFileSync(join(root, "queue.txt"), queue.map((row) => row.join("\t")).join("\n") + "\n");
  writeFileSync(join(root, "scripts/resolve-available-folder.mjs"), `import { copyFileSync } from "node:fs";\ncopyFileSync(${JSON.stringify(join(root, "queue.txt"))}, process.argv[2]);\n`);
  writeFileSync(join(root, "scripts/net-gate.mjs"), gate === "pass" ? "process.exit(0);\n" : "console.log('net-gate: GoLogin still unreachable');\nprocess.exit(3);\n");
  for (const [id, list] of Object.entries(outcomes)) writeFileSync(join(root, "outcomes", id), list.join("\n") + "\n");
  for (const [id] of queue) {
    writeFileSync(join(root, "data", `state-${id}.json`), JSON.stringify({ pause: paused.includes(id) ? { kind: "uncertain_connection", reason: "review" } : null }));
  }
  const stub = (name, body) => { writeFileSync(join(root, "bin", name), `#!/bin/bash\n${body}\n`); chmodSync(join(root, "bin", name), 0o755); };
  stub("pgrep", "exit 1");
  stub("caffeinate", "exit 0");
  stub("npm", `if [ "$1" = "run" ] && [ "$2" = "once" ]; then
  f="${join(root, "outcomes")}/$5"; line="$(head -1 "$f")"; tail -n +2 "$f" > "$f.next"; mv "$f.next" "$f"
  case "$line" in
    ok) echo "[gologin] Started GoLogin profile through local browser"; echo "Session closed."; exit 0 ;;
    infra) echo "[gologin] GoLogin accepted the start request."; echo "Session failure kind: infra"; exit 1 ;;
    operator) echo "[gologin] Started GoLogin profile through local browser"; echo "Session failure kind: operator"; exit 1 ;;
    account) echo "[gologin] Started GoLogin profile through local browser"; echo "Session failure kind: account"; exit 1 ;;
    refused) echo "[runner] No browser was started for this session; its proxy port was not used."; echo "Session failure kind: infra"; echo "GoLogin refused to start this profile: GoLogin local start returned an invalid response (HTTP 403): \"proxies.checkErrorGroups.failsInUserEnv\". No browser was started, so the browser lock is safe to release."; exit 1 ;;
    deferred) echo "Session deferred: GoLogin unreachable"; exit 75 ;;
  esac
fi
exit 0`);
  return root;
}

function runBatch(root) {
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, GL_API_TOKEN: "", GOLOGIN_API_TOKEN: "", WARMUP_LAST_PORT: "" };
  const run = spawnSync("bash", [join(root, "scripts/run-available-folder.sh")], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  rmSync(root, { recursive: true, force: true });
  return run.stdout + run.stderr;
}

const starts = (out) => [...out.matchAll(/=== START \[\d+\/\d+\] (\S+) port (\S+) \(previous port: (\S+)\)/g)].map(([, name, port, previous]) => ({ name, port, previous }));

test("infra failures retry once at the end, deferrals keep their place and port, operator stops are not failures", () => {
  const out = runBatch(batchTree({
    queue: [["a1", "Alpha", "5001"], ["b1", "Bravo", "5004"], ["c1", "Charlie", "5001"], ["d1", "Delta", "5005"]],
    outcomes: { a1: ["infra", "ok"], b1: ["deferred", "ok"], c1: ["ok"], d1: ["operator"] },
  }));
  const runs = starts(out);
  assert.equal(runs.filter((run) => run.name === "Alpha").length, 2, out);
  assert.equal(runs.filter((run) => run.name === "Bravo").length, 2, out);
  assert.match(out, /RETRY LATER Alpha/);
  assert.match(out, /=== RETRY PASS: 1 profile/);
  assert.match(out, /PORT 5004 not consumed: Bravo deferred/);
  assert.match(out, /Delta interrupted by the operator; not counted/);
  assert.ok(out.indexOf("RETRY PASS") < out.lastIndexOf("START ["), "the retry runs after the main queue");
  for (const run of runs) assert.notEqual(run.port, run.previous, `${run.name} reused the previous port`);
  assert.match(out, /BATCH DONE .* ok=3 failed=0 infra=1 interrupted=1 deferred=1/);
});

test("an infra failure on a paused profile is not retried, and a second infra failure is not retried again", () => {
  const out = runBatch(batchTree({
    queue: [["a1", "Alpha", "5001"], ["b1", "Bravo", "5004"], ["c1", "Charlie", "5005"]],
    outcomes: { a1: ["infra", "infra"], b1: ["infra"], c1: ["ok"] },
    paused: ["b1"],
  }));
  assert.equal(starts(out).filter((run) => run.name === "Alpha").length, 2, out);
  assert.equal(starts(out).filter((run) => run.name === "Bravo").length, 1, out);
  assert.match(out, /Bravo is paused \(uncertain_connection\)/);
  assert.match(out, /Alpha failed for infrastructure reasons again; not retrying/);
});

test("a GoLogin outage stops the batch cleanly and lists what is left without starting a browser", () => {
  const out = runBatch(batchTree({
    queue: [["a1", "Alpha", "5001"], ["b1", "Bravo", "5004"]],
    outcomes: { a1: ["ok"], b1: ["ok"] },
    gate: "fail",
  }));
  assert.equal(starts(out).length, 0, out);
  assert.match(out, /=== STOP: network or GoLogin API unavailable/);
  assert.match(out, /--- left ---\n(?:.*\n)*Alpha port 5001/);
  assert.match(out, /Bravo port 5004/);
});


test("Gopal 5001, then Prakash's GoLogin 403 before any browser, does not let Kamlesh open on 5001 next", () => {
  const out = runBatch(batchTree({
    queue: [["gopal", "Gopal", "5001"], ["kamlesh", "Kamlesh", "5001"], ["prakash", "Prakash", "5007"], ["xavier", "Xavier", "5004"]],
    outcomes: { gopal: ["ok"], prakash: ["refused", "ok"], kamlesh: ["ok"], xavier: ["ok"] },
  }));
  const runs = starts(out);
  assert.deepEqual(runs.slice(0, 3).map((run) => run.name), ["Gopal", "Prakash", "Xavier"], out);
  assert.match(out, /PORT 5007 not consumed: Prakash never opened a browser/);
  assert.equal(runs[2].previous, "5001", "the refused 5007 start did not replace Gopal's port");
  for (const run of runs) assert.notEqual(run.port, run.previous, `${run.name} reused the previous port`);
  assert.equal(runs.filter((run) => run.name === "Prakash").length, 2, "the refusal is retried once at the end");
});
