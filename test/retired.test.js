import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "warmup-retired-"));
const registryFile = join(root, "profiles.json");
const retired = { at: "2026-10-12T04:35:00+05:30", reason: "LinkedIn banned the account" };
// enabled: true on purpose: retirement must win even if someone flips the flag back.
const registry = { version: 1, profiles: [
  { profileId: "r1", profileName: "Retired One", enabled: true, retired },
  { profileId: "a1", profileName: "Active One", enabled: true },
] };
writeFileSync(registryFile, JSON.stringify(registry));
const pausedState = { pause: { kind: "challenge", reason: "LinkedIn security challenge", at: "2026-10-11T20:14:50.265Z" } };
writeFileSync(join(root, "state-r1.json"), JSON.stringify(pausedState));
process.env.WARMUP_PROFILES_FILE = registryFile;
process.env.WARMUP_DATA_DIR = root;

const { loadProfiles, retiredProfile } = await import("../src/profiles.js");
const { main } = await import("../src/index.js");

test("a retired profile loads as disabled even when enabled is true", () => {
  const profiles = loadProfiles();
  assert.equal(profiles.find((p) => p.profileId === "r1").enabled, false);
  assert.equal(profiles.find((p) => p.profileId === "a1").enabled, true);
  assert.equal(retiredProfile("r1", profiles)?.profileName, "Retired One");
  assert.equal(retiredProfile("a1", profiles), null);
});

test("a retired entry without a reason and date is rejected", () => {
  for (const bad of [{}, { reason: "x" }, { at: "2026-10-12" }, true]) {
    writeFileSync(registryFile, JSON.stringify({ version: 1, profiles: [{ profileId: "r1", profileName: "Retired One", enabled: false, retired: bad }] }));
    assert.throws(() => loadProfiles(), /needs retired/);
  }
  writeFileSync(registryFile, JSON.stringify(registry));
});

test("resume --reviewed refuses a retired profile and leaves its pause in place", async () => {
  await assert.rejects(main(["resume", "--profile", "r1", "--reviewed"]), /retired.*cannot be resumed/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "state-r1.json"), "utf8")).pause, pausedState.pause);
});

test("a single run refuses a retired profile", async () => {
  await assert.rejects(main(["once", "--profile", "Retired One"]), /retired/);
});

test("openWarmupBrowser refuses a retired profile before contacting GoLogin", async () => {
  process.env.GL_PROFILE_ID = "r1";
  process.env.GL_PROFILE_NAME = "Retired One";
  const { openWarmupBrowser } = await import("../src/browser/session.js");
  await assert.rejects(openWarmupBrowser(), /retired.*No browser is opened/);
});

test("the batch resolver skips a retired profile even if its raw entry says enabled", () => {
  const resolver = fileURLToPath(new URL("../scripts/resolve-available-folder.mjs", import.meta.url));
  const profiles = [{ id: "r1", name: "Retired One", proxy: { port: 5001 } }, { id: "a1", name: "Active One", proxy: { port: 5004 } }];
  writeFileSync(join(root, "fetch-stub.mjs"), `
const profiles = ${JSON.stringify(profiles)};
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  const body = path === "/folders" ? [{ id: "f1", name: "Harvest", associatedProfiles: profiles.map((p) => p.id) }]
    : path === "/browser/v2" ? { profiles, allProfilesCount: profiles.length } : null;
  return { ok: body != null, status: body ? 200 : 404, text: async () => JSON.stringify(body) };
};`);
  writeFileSync(join(root, "state-r1.json"), JSON.stringify({}));
  const run = spawnSync(process.execPath, ["--import", join(root, "fetch-stub.mjs"), resolver, join(root, "queue.txt")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GL_API_TOKEN: "test", WARMUP_FOLDERS: "Harvest", WARMUP_ONLY_IDS: "", WARMUP_SKIP_COMPLETED: "", WARMUP_SKIP_PORTS: "" },
  });
  const out = run.stdout + run.stderr;
  assert.equal(run.status, 0, out);
  assert.equal(readFileSync(join(root, "queue.txt"), "utf8"), "a1\tActive One\t5004\n", out);
  assert.match(out, /SKIP Retired One: retired \(LinkedIn banned the account\)/);
});
