import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";
import { config } from "../config.js";
import { createGoLoginClient } from "../gologin/client.js";
import { createLogger } from "../logger.js";
import { sleep } from "../util/random.js";

const log = createLogger("browser");

async function discoverProfileDebuggerUrl(profileId) {
  if (!profileId) return null;
  let listing = "";
  try {
    listing = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
  } catch {
    return null;
  }
  for (const line of listing.split("\n")) {
    if (!line.includes(`GoLogin/profiles/${profileId}`)) continue;
    if (!/Orbita-Browser\.app\/Contents\/MacOS\/Orbita/.test(line)) continue;
    const match = line.match(/--remote-debugging-port=(\d+)/);
    if (!match) continue;
    try {
      const response = await fetch(`http://127.0.0.1:${match[1]}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const json = await response.json();
      const wsUrl = json.webSocketDebuggerUrl;
      if (!wsUrl) continue;
      const url = new URL(wsUrl);
      if (url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return wsUrl;
    } catch { /* this port is not a debugger */ }
  }
  return null;
}

async function connectWs(wsUrl) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
        protocolTimeout: 90_000,
      });
    } catch (error) {
      log.warn(`CDP connect attempt ${attempt} failed`, { message: error.message });
      await sleep(1500 * attempt);
    }
  }
  throw new Error("Could not attach Puppeteer to the GoLogin Orbita websocket.");
}

function assertProfileLock(profile) {
  if (!profile.name || !config.profileName) return;
  if (profile.name.toLowerCase() !== config.profileName.toLowerCase()) {
    throw new Error(`Refusing to run on "${profile.name}". This scenario is locked to ${config.profileName}.`);
  }
}

export async function openWarmupBrowser() {
  const gologin = await createGoLoginClient();
  const profile = await gologin.resolveProfile();
  assertProfileLock(profile);
  const existing = await discoverProfileDebuggerUrl(profile.profile_id);
  if (existing) {
    log.info("Attaching to an already-running local Orbita debugger.", { profile: profile.name });
    const browser = await connectWs(existing);
    return {
      profile,
      browser,
      startedByUs: false,
      async stop() {
        log.info("Leaving the GoLogin profile running.");
      },
    };
  }
  const { wsUrl, startedByUs } = await gologin.startProfile(profile);
  let browser;
  try { browser = await connectWs(wsUrl); }
  catch (error) { await gologin.stopProfile(); throw error; }
  return {
    profile,
    browser,
    startedByUs,
    async stop() {
      if (config.stopProfileAfterSession && startedByUs) {
        await sleep(2500);
        await gologin.stopProfile();
      } else {
        log.info("Leaving the GoLogin profile running.");
      }
    },
  };
}

export async function resolveWarmupProfile() {
  const gologin = await createGoLoginClient();
  return gologin.resolveProfile();
}
