import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completedSessionToday, orderByProxy, parseOnlyIds, pickNext } from "../scripts/proxy-queue.mjs";

const resolver = fileURLToPath(new URL("../scripts/resolve-available-folder.mjs", import.meta.url));

function fill(port, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${port}-${index}`,
    name: `p-${port}-${index}`,
    port: String(port),
  }));
}

test("Available Profiles port mix never places the same proxy on two consecutive runs", () => {
  const items = [
    ...fill(5001, 15),
    ...fill(5004, 10),
    ...fill(5005, 6),
    ...fill(5002, 1),
    ...fill(5003, 1),
    ...fill(5007, 1),
  ];
  const { ordered, deferred } = orderByProxy(items);
  assert.equal(deferred.length, 0);
  assert.equal(ordered.length, items.length);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.notEqual(ordered[index].port, ordered[index - 1].port);
  }
});

test("stops instead of repeating the previous port when nothing else is left", () => {
  const items = [...fill(5005, 3), ...fill(5001, 1)];
  const { ordered, deferred } = orderByProxy(items);
  assert.deepEqual(ordered.map((item) => item.port), ["5005", "5001", "5005"]);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].port, "5005");
  assert.equal(pickNext(deferred, "5005"), null);
});

test("a later failure does not hide an earlier completed session the same day", () => {
  const state = {
    lastSession: { dateKey: "2026-10-09", aborted: true, testRun: false },
    history: [
      { dateKey: "2026-10-09", aborted: false, testRun: false },
      { dateKey: "2026-10-09", aborted: true, testRun: false },
    ],
  };
  assert.equal(completedSessionToday(state, "2026-10-09"), true);
  assert.equal(completedSessionToday({ lastSession: { dateKey: "2026-10-09", aborted: true } }, "2026-10-09"), false);
  assert.equal(completedSessionToday({ lastSession: { dateKey: "2026-10-09", aborted: false, testRun: true } }, "2026-10-09"), false);
});

test("WARMUP_ONLY_IDS parses comma lists and treats blank as no filter", () => {
  assert.equal(parseOnlyIds(undefined), null);
  assert.equal(parseOnlyIds(" , "), null);
  assert.deepEqual([...parseOnlyIds("a1, b2,,c3 ")], ["a1", "b2", "c3"]);
});

test("WARMUP_ONLY_IDS narrows the folder but keeps the paused and disabled skips", () => {
  const root = mkdtempSync(join(tmpdir(), "warmup-resolve-"));
  const profiles = [["a1", "Alpha", 5001], ["b1", "Bravo", 5004], ["c1", "Charlie", 5005], ["d1", "Delta", 5007]];
  writeFileSync(join(root, "fetch-stub.mjs"), `
const profiles = ${JSON.stringify(profiles.map(([id, name, port]) => ({ id, name, proxy: { port } })))};
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  const body = path === "/folders" ? [{ id: "f1", name: "Harvest", associatedProfiles: profiles.map((p) => p.id) }]
    : path === "/browser/v2" ? { profiles, allProfilesCount: profiles.length } : null;
  return { ok: body != null, status: body ? 200 : 404, text: async () => JSON.stringify(body) };
};`);
  const registry = { version: 1, profiles: [
    { profileId: "a1", profileName: "Alpha", enabled: true },
    { profileId: "b1", profileName: "Bravo", enabled: true },
    { profileId: "d1", profileName: "Delta", enabled: false },
  ] };
  writeFileSync(join(root, "profiles.json"), JSON.stringify(registry));
  writeFileSync(join(root, "state-b1.json"), JSON.stringify({ pause: { kind: "challenge", reason: "review" } }));
  const run = spawnSync(process.execPath, ["--import", join(root, "fetch-stub.mjs"), resolver, join(root, "queue.txt")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GL_API_TOKEN: "test", WARMUP_DATA_DIR: root, WARMUP_PROFILES_FILE: join(root, "profiles.json"),
      WARMUP_FOLDERS: "Harvest", WARMUP_ONLY_IDS: "a1,b1,d1,zz9", WARMUP_SKIP_COMPLETED: "", WARMUP_SKIP_PORTS: "" },
  });
  const out = run.stdout + run.stderr;
  const queue = readFileSync(join(root, "queue.txt"), "utf8");
  const after = JSON.parse(readFileSync(join(root, "profiles.json"), "utf8"));
  rmSync(root, { recursive: true, force: true });
  assert.equal(run.status, 0, out);
  assert.equal(queue, "a1\tAlpha\t5001\n", out);
  assert.match(out, /SKIP Bravo: paused \(challenge: review\)/);
  assert.match(out, /SKIP Delta: disabled/);
  assert.match(out, /WARN WARMUP_ONLY_IDS not in the requested folders, ignored: zz9/);
  assert.equal(after.profiles.some((p) => p.profileId === "c1"), false, "a filtered-out profile must not be enrolled");
});

test("a profile that never opens a browser does not license the same port next", () => {
  const items = [...fill(5001, 2), ...fill(5004, 1)];
  const afterFirst = items.filter((item) => item.id !== "5001-0");
  assert.equal(pickNext(afterFirst, "5001").port, "5004");
  const blockedMiddleRemoved = afterFirst.filter((item) => item.id !== "5004-0");
  assert.equal(pickNext(blockedMiddleRemoved, "5001"), null);
});
