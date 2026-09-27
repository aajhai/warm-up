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

function isLocalDebuggerUrl(wsUrl) {
  const url = new URL(wsUrl);
  return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

async function waitForDebuggerHttp(wsUrl, timeoutMs = 45_000) {
  const endpoint = new URL(wsUrl);
  endpoint.protocol = "http:";
  endpoint.pathname = "/json/version";
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(2_500) });
      if (response.ok) {
        const json = await response.json();
        if (json.webSocketDebuggerUrl) return;
      }
      lastError = new Error(`Debugger HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw new Error(`Orbita debugger was not healthy before connect: ${lastError?.message || "unknown"}`);
}

async function connectWs(wsUrl) {
  if (isLocalDebuggerUrl(wsUrl)) {
    await waitForDebuggerHttp(wsUrl);
    // Give Orbita a moment after the debugger port answers — attaching during the
    // first LinkedIn paint can wedge Network.enable on some local profiles.
    await sleep(4_000);
  }
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    let browser;
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
        // A wedged cloud Runtime.callFunctionOn must fail quickly enough for the
        // runner to disconnect and stop the owned profile.
        protocolTimeout: isLocalDebuggerUrl(wsUrl) ? 45_000 : 15_000,
      });
      // Probe without waiting the full protocolTimeout if the tab target is wedged.
      await Promise.race([
        browser.pages(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("browser.pages probe timed out")), isLocalDebuggerUrl(wsUrl) ? 30_000 : 15_000)),
      ]);
      if (isLocalDebuggerUrl(wsUrl)) await sleep(3_000);
      return browser;
    } catch (error) {
      log.warn(`CDP connect attempt ${attempt} failed`, { message: error.message });
      try { await browser?.disconnect(); } catch { /* ignore */ }
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
