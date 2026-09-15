import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

test("scheduler process isolates a corrupt profile, persists alerts locally, and releases locks on SIGTERM", { timeout: 12_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "warmup-service-"));
  writeFileSync(join(root, "profiles.json"), JSON.stringify({ version: 1, profiles: [
    { profileId: "broken", profileName: "Broken fixture", enabled: true },
    { profileId: "paused", profileName: "Paused fixture", enabled: true },
  ] }));
  writeFileSync(join(root, "state-broken.json"), "{broken");
  writeFileSync(join(root, "state-paused.json"), JSON.stringify({ schemaVersion: 2, daily: {}, weekly: {}, actions: [], windows: {}, pause: { reason: "Fixture: never launch a browser" } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/index.js", import.meta.url)), "schedule"], {
    env: { ...process.env, WARMUP_DATA_DIR: root, WARMUP_PROFILES_FILE: join(root, "profiles.json"), WARMUP_LOG_DIR: join(root, "logs"), SLACK_WEBHOOK_URL: "", GL_API_TOKEN: "", GOLOGIN_API_TOKEN: "", GL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 3000;
    while (!output.includes("Profile scheduling blocked") && Date.now() < deadline && child.exitCode === null) await sleep(25);
    assert.match(output, /Profile scheduling blocked \(Broken fixture\)/);
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0, output);
    assert.equal(signal, null);
    assert.deepEqual(readdirSync(join(root, "locks")), []);
    const events = readdirSync(join(root, "notifications")).map((name) => JSON.parse(readFileSync(join(root, "notifications", name))).text);
    assert.equal(events.length, 3);
    assert.equal(events.filter((text) => text.includes("profile_scheduling_failed")).length, 1);
    assert.ok(events.some((text) => text.includes("Profile: Broken fixture (broken)")));
    assert.ok(events.some((text) => text.includes("service_stopped")));
    assert.equal(readFileSync(join(root, "state-broken.json"), "utf8"), "{broken");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    rmSync(root, { recursive: true, force: true });
  }
});
