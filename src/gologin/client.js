import { LocalProfileLauncher } from "./local.js";
import { CloudProfileLauncher } from "./cloud.js";
import { config } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("gologin");
const API_URL = "https://api.gologin.com";

async function apiGet(path, token) {
  const response = await fetch(`${API_URL}${path}`, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const message = json?.message || json?.error || text || response.statusText;
    const error = new Error(`GET ${path} -> ${response.status} ${message}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

export class GoLoginClient {
  constructor() {
    this.token = config.gologinToken;
    this.gl = null;
  }

  requireToken() {
    if (!this.token) {
      throw new Error(
        "GoLogin API token missing. Put GL_API_TOKEN in .env (Settings → API in the GoLogin app). Do not paste it in chat.",
      );
    }
    return this.token;
  }

  async listProfiles(search = "") {
    const token = this.requireToken();
    const query = new URLSearchParams({
      page: "1",
      sorterField: "name",
      sorterOrder: "ascend",
    });
    if (search) query.set("search", search);
    const json = await apiGet(`/browser/v2?${query}`, token);
    return json.profiles || [];
  }

  async resolveProfile() {
    if (config.profileId) {
      const token = this.requireToken();
      const profile = await apiGet(`/browser/${config.profileId}`, token);
      return {
        name: profile.name || config.profileName,
        profile_id: profile.id || config.profileId,
        os: profile.os,
        isRunning: Boolean(profile.isRunning),
      };
    }

    const wanted = config.profileName.trim();
    if (!wanted) {
      throw new Error("Set GL_PROFILE_ID or GL_PROFILE_NAME in .env.");
    }

    const profiles = await this.listProfiles(wanted);
    const matches = profiles.filter((profile) => {
      const name = (profile.name || "").trim();
      return name.toLowerCase() === wanted.toLowerCase();
    });
    const chosen = matches.length === 1 ? matches[0] : null;
    if (!chosen) {
      const names = profiles.map((profile) => profile.name).join(", ") || "(none)";
      throw new Error(`Could not uniquely resolve GoLogin profile "${wanted}". Found: ${names}`);
    }
    log.info("Resolved GoLogin profile", { name: chosen.name, profile_id: chosen.id, running: chosen.isRunning });
    return {
      name: chosen.name,
      profile_id: chosen.id,
      os: chosen.os,
      isRunning: Boolean(chosen.isRunning),
    };
  }

  async startProfile(profile) {
    const token = this.requireToken();
    if (profile.isRunning) {
      throw new Error("GoLogin profile is already running. Close it in the app before this service starts it.");
    }
    if (!['cloud', 'local'].includes(config.browserMode)) {
      throw new Error(`Unsupported GOLOGIN_BROWSER_MODE: ${config.browserMode}`);
    }
    this.gl = config.browserMode === "cloud"
      ? new CloudProfileLauncher({ token })
      : new LocalProfileLauncher({ token });
    const wsUrl = await this.gl.start(profile.profile_id);
    log.info(`Started GoLogin profile through ${config.browserMode} browser`, { profile_id: profile.profile_id });
    return { wsUrl, startedByUs: true };
  }

  async stopProfile() {
    if (!this.gl) return;
    await this.gl.stop();
    this.gl = null;
    log.info(`Stopped GoLogin profile through ${config.browserMode} browser`);
  }
}

export async function createGoLoginClient() {
  const client = new GoLoginClient();
  client.requireToken();
  return client;
}
