// Resolves one or more GoLogin folders into one run queue for run-available-folder.sh.
// Writes "<profileId>\t<profileName>\t<proxyPort>" lines, enrolls missing profiles
// in data/profiles.json, and skips paused profiles. The shell picks the next line
// so the proxy port that just opened a browser is not used again, including across folders.
// Folder names: WARMUP_FOLDERS (one name per line), else WARMUP_FOLDER, else "Available Profiles".
// WARMUP_ONLY_IDS (comma-separated ids) narrows the folders to those profiles; every other skip still applies.
// Usage: node scripts/resolve-available-folder.mjs <queueFile> [--dry-run]
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/util/files.js";
import { dataDir } from "../src/util/paths.js";
import { registryPath } from "../src/profiles.js";
import { istNow } from "../src/util/time.js";
import { completedSessionToday, formatQueue, orderByProxy, parseOnlyIds } from "./proxy-queue.mjs";

const API_URL = "https://api.gologin.com";

function requestedFolders() {
  const many = process.env.WARMUP_FOLDERS;
  const names = many && many.trim()
    ? many.split("\n").map((name) => name.trim()).filter(Boolean)
    : [process.env.WARMUP_FOLDER || "Available Profiles"];
  return [...new Set(names)];
}
const [queueFile, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");

function fail(message, code = 1) {
  console.error(`resolve: ${message}`);
  process.exit(code);
}

if (!queueFile) fail("queue file argument is required.");
const token = process.env.GL_API_TOKEN || process.env.GOLOGIN_API_TOKEN || "";
if (!token) fail("No GoLogin token. Set GL_API_TOKEN or GOLOGIN_API_TOKEN in .env.", 2);

async function apiGet(path) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path.split("?")[0]} -> HTTP ${response.status}`);
  return text ? JSON.parse(text) : null;
}

function portOf(profile) {
  const port = profile?.proxy?.port;
  if (port == null || port === "") return "";
  return String(port);
}

async function listFolderProfiles(folder) {
  const byId = new Map();
  for (let page = 1; page <= 50; page += 1) {
    const query = new URLSearchParams({ page: String(page), folder: folder.name });
    const json = await apiGet(`/browser/v2?${query}`);
    const profiles = json?.profiles || [];
    for (const profile of profiles) byId.set(String(profile.id), profile);
    const total = json?.allProfilesCount ?? byId.size;
    if (profiles.length === 0 || byId.size >= total) break;
  }
  return byId;
}

function pauseOf(profileId) {
  const path = join(dataDir, `state-${profileId}.json`);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    return state.pause ? `${state.pause.kind || "paused"}: ${state.pause.reason}` : null;
  } catch {
    return "state file unreadable; manual review required";
  }
}

function stateOf(profileId) {
  const path = join(dataDir, `state-${profileId}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function skipPorts() {
  return new Set(String(process.env.WARMUP_SKIP_PORTS || "").split(",").map((port) => port.trim()).filter(Boolean));
}

const folderNames = requestedFolders();
let folders;
try { folders = await apiGet("/folders"); }
catch (error) { fail(`could not list GoLogin folders (${error.message}).`); }
const list = Array.isArray(folders) ? folders : folders?.folders || [];

const ids = [];
const seen = new Set();
const listed = new Map();
for (const name of folderNames) {
  const matches = list.filter((f) => f?.name === name);
  if (matches.length !== 1) fail(`expected exactly one folder named "${name}", found ${matches.length}.`);
  const folder = matches[0];
  let folderProfiles;
  try { folderProfiles = await listFolderProfiles(folder); }
  catch (error) { fail(`could not list profiles in "${name}" (${error.message}).`); }
  for (const [id, profile] of folderProfiles) listed.set(id, profile);
  const folderIds = [...new Set(
    Array.isArray(folder.associatedProfiles) && folder.associatedProfiles.length
      ? folder.associatedProfiles.map(String)
      : [...folderProfiles.keys()],
  )];
  for (const id of folderIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  console.log(`resolve: folder "${name}" (${folder.id}) has ${folderIds.length} profiles.`);
}

const registry = existsSync(registryPath)
  ? JSON.parse(readFileSync(registryPath, "utf8"))
  : { version: 1, profiles: [] };
if (registry.version !== 1 || !Array.isArray(registry.profiles)) fail("data/profiles.json is not a version 1 registry.");

const onlyIds = parseOnlyIds(process.env.WARMUP_ONLY_IDS);
if (onlyIds) {
  const missing = [...onlyIds].filter((id) => !seen.has(id));
  console.log(`resolve: WARMUP_ONLY_IDS keeps ${onlyIds.size - missing.length} of ${ids.length} folder profile(s).`);
  if (missing.length) console.log(`WARN WARMUP_ONLY_IDS not in the requested folders, ignored: ${missing.join(", ")}`);
}

const queue = [];
const added = [];
for (const id of ids) {
  if (onlyIds && !onlyIds.has(id)) continue;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) { console.log(`SKIP ${id}: invalid GoLogin id`); continue; }
  let remote = listed.get(id);
  if (!remote) {
    try { remote = await apiGet(`/browser/${id}`); }
    catch (error) { console.log(`SKIP ${id}: could not load profile (${error.message})`); continue; }
  }
  const port = portOf(remote);
  let entry = registry.profiles.find((p) => p.profileId === id);
  if (!entry) {
    const name = remote?.name;
    if (!name) { console.log(`SKIP ${id}: GoLogin returned no name`); continue; }
    const clash = registry.profiles.find((p) => p.profileName.toLowerCase() === name.toLowerCase());
    if (clash) { console.log(`SKIP ${name} (${id}): name already enrolled under another id (${clash.profileId})`); continue; }
    entry = { profileId: id, profileName: name, enabled: true };
    registry.profiles.push(entry);
    added.push(entry);
  }
  if (entry.retired) { console.log(`SKIP ${entry.profileName}: retired (${entry.retired.reason || "no reason"})`); continue; }
  if (!entry.enabled) { console.log(`SKIP ${entry.profileName}: disabled in data/profiles.json`); continue; }
  const pause = pauseOf(id);
  if (pause) { console.log(`SKIP ${entry.profileName}: paused (${pause})`); continue; }
  if (skipPorts().has(port)) { console.log(`SKIP ${entry.profileName}: proxy port ${port} skipped this pass`); continue; }
  if (process.env.WARMUP_SKIP_COMPLETED === "1" && completedSessionToday(stateOf(id), istNow().dateKey)) {
    console.log(`SKIP ${entry.profileName}: already completed a non-aborted session today`);
    continue;
  }
  if (!port) console.log(`WARN ${entry.profileName}: no proxy port; it will not run next to another profile without a port.`);
  queue.push({ id, name: entry.profileName, port });
}

if (added.length) {
  const names = added.map((p) => p.profileName).join(", ");
  if (dryRun) console.log(`resolve: would enroll ${added.length} new profile(s): ${names}`);
  else {
    writeJsonAtomic(registryPath, registry);
    console.log(`resolve: enrolled ${added.length} new profile(s): ${names}`);
  }
}
const counts = new Map();
for (const item of queue) counts.set(item.port || "none", (counts.get(item.port || "none") || 0) + 1);
const mix = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log(`resolve: proxy ports queued: ${mix.map(([port, count]) => `${port}×${count}`).join(", ") || "none"}.`);
const { ordered, deferred } = orderByProxy(queue);
console.log("resolve: run order if every profile opens a browser:");
ordered.forEach((item, index) => console.log(`  ${index + 1}. ${item.name} port ${item.port || "none"}`));
if (deferred.length) {
  console.log(`resolve: ${deferred.length} profile(s) cannot start without repeating the previous proxy port. The batch stops before them if every earlier profile opens a browser:`);
  for (const item of deferred) console.log(`  ${item.name} port ${item.port || "none"}`);
}
writeFileSync(queueFile, formatQueue(queue));
console.log(`resolve: ${queue.length} profile(s) queued.`);
