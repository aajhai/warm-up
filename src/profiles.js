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
    if (profile.retired !== undefined && (!profile.retired || typeof profile.retired.reason !== "string" || !profile.retired.reason || !Number.isFinite(Date.parse(profile.retired.at)))) {
      throw new Error(`Retired profile ${profile.profileName} needs retired: { at, reason }.`);
    }
    // Retirement is permanent: flipping enabled back to true does not bring a retired profile back.
    if (profile.retired) profile.enabled = false;
    ids.add(profile.profileId);
  }
  return profiles;
}

export function retiredProfile(profileId, profiles = loadProfiles()) {
  return profiles.find((p) => p.profileId === profileId && p.retired) || null;
}

export function assertNotRetired(profileId) {
  const retired = profileId ? retiredProfile(profileId) : null;
  if (retired) throw new Error(`${retired.profileName} is retired (${retired.retired.reason}, ${retired.retired.at}). No browser is opened for a retired profile.`);
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
