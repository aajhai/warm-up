import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./util/paths.js";

export const registryPath = process.env.WARMUP_PROFILES_FILE || join(dataDir, "profiles.json");

export function loadProfiles() {
  let profiles;
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    if (registry.version !== 1 || !Array.isArray(registry.profiles)) throw new Error("Invalid profile registry.");
    profiles = registry.profiles;
  } else {
    profiles = [{
      profileId: process.env.GL_PROFILE_ID || process.env.GOLOGIN_PROFILE_ID,
      profileName: process.env.GL_PROFILE_NAME || process.env.GOLOGIN_PROFILE_NAME,
      enabled: true,
    }];
  }
  const ids = new Set();
  for (const profile of profiles) {
    if (!profile.profileId || !/^[a-zA-Z0-9_-]+$/.test(profile.profileId) || !profile.profileName) throw new Error("Every enrolled profile requires its GoLogin ID and name.");
    if (ids.has(profile.profileId)) throw new Error("Duplicate profile ID in registry.");
    if (typeof profile.enabled !== "boolean") throw new Error("Every profile requires enabled: true or false.");
    ids.add(profile.profileId);
  }
  return profiles;
}

export function selectProfile(selector) {
  const profiles = loadProfiles();
  const matches = selector
    ? profiles.filter((p) => p.profileId === selector || p.profileName.toLowerCase() === selector.toLowerCase())
    : profiles.filter((p) => p.enabled);
  if (matches.length !== 1) throw new Error("Choose one enrolled profile with --profile <ID or exact name>.");
  const profile = matches[0];
  process.env.GL_PROFILE_ID = profile.profileId;
  process.env.GL_PROFILE_NAME = profile.profileName;
  return profile;
}
