import "dotenv/config";
import puppeteer from "puppeteer-core";
import { createGoLoginClient } from "../src/gologin/client.js";
import { foregroundPage } from "../src/browser/page.js";
import { TrustedPointer } from "../src/human/trackpad.js";

const FEED = "https://www.linkedin.com/feed/";
const TARGET_LIKES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function workingPage(browser) {
  const pages = await browser.pages();
  const urls = pages.map((p) => p.url());
  console.log(JSON.stringify({ step: "tabs", urls }));
  const feedTabs = pages.filter((p) => /linkedin\.com\/feed\/?(\?|$)/.test(p.url()));
  let page = feedTabs[0] || pages.find((p) => /linkedin\.com/.test(p.url())) || pages[0];
  if (feedTabs.length > 1) {
    let best = feedTabs[0];
    let bestCount = -1;
    for (const tab of feedTabs) {
      const count = await tab.evaluate(() => document.querySelectorAll("button, [role='button']").length).catch(() => 0);
      if (count > bestCount) {
        best = tab;
        bestCount = count;
      }
    }
    page = best;
  }
  if (!page) throw new Error("No tab to use.");
  await foregroundPage(page);
  return page;
}

function likeProbeWorld() {
  function labelOf(el) {
    return `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function isMedia(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (["IMG", "PICTURE", "VIDEO", "CANVAS", "SOURCE"].includes(tag)) return true;
    if (el.getAttribute("role") === "img") return true;
    if (el.closest("figure, picture, video, [role='img']")) return true;
    const link = el.closest("a");
    return Boolean(link && link.querySelector("img, video, picture, canvas"));
  }

  function isComment(el) {
    return el.tagName === "BUTTON" && /\bcomment\b/.test(labelOf(el)) && !/see more comments|view more comments/.test(labelOf(el));
  }

  function sitsInSocialBar(button) {
    const r = button.getBoundingClientRect();
    let row = button.parentElement;
    for (let depth = 0; row && depth < 8; depth += 1, row = row.parentElement) {
      const comments = [...row.querySelectorAll("button, [role='button']")].filter(isComment);
      if (!comments.length) continue;
      const cr = comments[0].getBoundingClientRect();
      if (Math.abs(cr.top - r.top) < 32 && Math.abs(cr.height - r.height) < 32) return true;
    }
    return false;
  }

  function isActionBarLike(el) {
    if (el.tagName !== "BUTTON" && (el.getAttribute("role") || "").toLowerCase() !== "button") return false;
    const label = labelOf(el);
    if (!/reaction button state: no reaction/.test(label) || !/\blike\b/.test(label)) return false;
    if (/\bunlike\b/.test(label) || /comment|repost|\bsend\b/.test(label)) return false;
    if (el.getAttribute("aria-pressed") === "true") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.width > 220 || r.height < 16 || r.height > 64) return false;
    return sitsInSocialBar(el);
  }

  function cardFor(button) {
    let el = button.parentElement;
    for (let i = 0; i < 14 && el && el !== document.body; i += 1, el = el.parentElement) {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      const person = el.querySelector("a[href*='/in/'], a[href*='/company/']");
      if (text.length > 80 && person) return el;
    }
    return null;
  }

  function permalink(root) {
    const hrefs = [...root.querySelectorAll("a[href]")].map((a) => a.href.split("?")[0]);
    return hrefs.find((h) => /\/feed\/update\//.test(h) || /urn:li:activity/.test(h) || /\/posts\//.test(h))
      || hrefs.find((h) => /linkedin\.com\/in\//.test(h) || /linkedin\.com\/company\//.test(h))
      || null;
  }

  function author(root) {
    const names = [...root.querySelectorAll("a[href*='/in/'], a[href*='/company/']")]
      .map((a) => (a.innerText || "").trim().split("\n")[0].trim())
      .filter((n) => n && n.length < 80);
    return names[0] || null;
  }

  function clickPoint(button) {
    const r = button.getBoundingClientRect();
    return {
      x: r.x + Math.min(Math.max(r.width * 0.45, 18), r.width - 10),
      y: r.y + r.height * 0.5,
      width: r.width,
      height: r.height,
      top: r.top,
      bottom: r.bottom,
    };
  }

  function findLike(wanted) {
    return [...document.querySelectorAll("button, [role='button']")].find((el) => {
      if (!isActionBarLike(el)) return false;
      const card = cardFor(el);
      if (!card) return false;
      const text = (card.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
      const links = [...card.querySelectorAll("a[href]")].map((a) => a.href.split("?")[0]);
      return (wanted.href && links.includes(wanted.href)) || text === wanted.snippet;
    }) || null;
  }

  function inspect() {
    return [...document.querySelectorAll("button, [role='button']")]
      .filter(isActionBarLike)
      .flatMap((button, index) => {
        const card = cardFor(button);
        if (!card) return [];
        const r = clickPoint(button);
        const text = (card.innerText || "").replace(/\s+/g, " ").trim();
        return [{
          index,
          ...r,
          inView: r.top >= 90 && r.bottom <= innerHeight - 80,
          pressed: button.getAttribute("aria-pressed") === "true",
          label: (button.getAttribute("aria-label") || button.innerText || "").trim(),
          href: permalink(card),
          author: author(card),
          snippet: text.slice(0, 180),
        }];
      })
      .filter((t) => t.author && t.snippet.length > 40);
  }

  function coords(wanted) {
    const button = findLike(wanted);
    if (!button) return null;
    return { ...clickPoint(button), vh: innerHeight, label: labelOf(button) };
  }

  function align(wanted) {
    const button = findLike(wanted);
    if (!button) return null;
    button.scrollIntoView({ block: "end", inline: "nearest" });
    return coords(wanted);
  }

  function probe(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { safe: false, reason: "empty" };
    if (isMedia(el)) return { safe: false, reason: "media", tag: el.tagName };
    const host = el.closest("button, [role='button']");
    if (!host) return { safe: false, reason: "not-button", tag: el.tagName };
    if (!isActionBarLike(host) && !/\blike\b/.test(labelOf(host))) {
      return { safe: false, reason: "not-like-button", label: labelOf(host) };
    }
    if (!sitsInSocialBar(host)) return { safe: false, reason: "not-action-bar", label: labelOf(host) };
    return { safe: true, label: labelOf(host) };
  }

  function overlayOpen() {
    const dialog = document.querySelector("[role='dialog'], [aria-modal='true']");
    return Boolean(dialog && dialog.querySelector("img, video, picture"));
  }

  function isLikedControl(el) {
    if (!el) return false;
    const label = labelOf(el);
    if (!/\blike\b|\bunlike\b/.test(label)) return false;
    if (/comment|repost|\bsend\b/.test(label)) return false;
    if (el.getAttribute("aria-pressed") === "true" || /\bunlike\b/.test(label)) return true;
    return /reaction button state:/.test(label) && !/no reaction/.test(label);
  }

  function confirm(wanted) {
    const matches = [...document.querySelectorAll("div, article, li, section")].filter((el) => {
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      return wanted.snippet && text.includes(wanted.snippet.slice(0, 80));
    });
    const card = matches.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0] || null;
    const root = card || document;
    const like = [...root.querySelectorAll("button, [role='button']")].find((el) => {
      const label = labelOf(el);
      if (!/\blike\b|\bunlike\b/.test(label)) return false;
      if (/comment|repost|\bsend\b/.test(label)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.width > 220 || r.height < 16 || r.height > 64) return false;
      return sitsInSocialBar(el);
    });
    const label = like ? labelOf(like) : "";
    return {
      liked: Boolean(like && isLikedControl(like)),
      pressed: like ? like.getAttribute("aria-pressed") : null,
      label,
      foundCard: Boolean(card),
      overlay: overlayOpen(),
    };
  }

  return { inspect, align, coords, probe, overlayOpen, confirm };
}

async function runProbe(page, method, ...args) {
  return page.evaluate((worldSrc, name, callArgs) => {
    const world = (0, eval)(`(${worldSrc})`)();
    return world[name](...callArgs);
  }, likeProbeWorld.toString(), method, args);
}

async function inspectTargets(page) {
  return runProbe(page, "inspect");
}

async function scrollLikeIntoView(page, href, snippet) {
  return runProbe(page, "align", { href, snippet });
}

async function probeLikePoint(page, x, y) {
  return runProbe(page, "probe", x, y);
}

async function mediaOverlayOpen(page) {
  return runProbe(page, "overlayOpen");
}

async function likeAt(page, x, y) {
  const pointer = new TrustedPointer(page);
  await pointer.move(x, y);
  await sleep(250);
  await pointer.click();
}

async function confirmLike(page, href, author, snippet) {
  return runProbe(page, "confirm", { href, author, snippet });
}

async function dismissOverlay(page) {
  if (await mediaOverlayOpen(page)) {
    await page.keyboard.press("Escape");
    await sleep(400);
    return true;
  }
  return false;
}

async function orbitaDebuggerPorts() {
  const ports = new Set([29693, 9222, 9229]);
  try {
    const { execFileSync } = await import("node:child_process");
    const listing = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    for (const line of listing.split("\n")) {
      if (!/Orbita-Browser\.app\/Contents\/MacOS\/Orbita/.test(line)) continue;
      const match = line.match(/--remote-debugging-port=(\d+)/);
      if (match) ports.add(Number(match[1]));
    }
  } catch { /* ps unavailable; try the known ports */ }
  return [...ports];
}

async function existingDebuggerUrl() {
  if (process.env.EXISTING_WS) return process.env.EXISTING_WS;
  for (const port of await orbitaDebuggerPorts()) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const json = await response.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch { /* not this port */ }
  }
  return null;
}

async function waitForDebugger(ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const url = await existingDebuggerUrl();
    if (url) return url;
    await sleep(1500);
  }
  return null;
}

async function orbitaIsRunning() {
  try {
    const { execFileSync } = await import("node:child_process");
    const listing = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
    return listing.split("\n").some((line) => /Orbita-Browser\.app\/Contents\/MacOS\/Orbita/.test(line));
  } catch {
    return false;
  }
}

async function main() {
  process.env.GOLOGIN_BROWSER_MODE = "local";
  let wsUrl = await existingDebuggerUrl();
  let gologin;
  let startedByUs = false;
  if (wsUrl) {
    console.log(JSON.stringify({ step: "attaching", wsUrl }));
  } else {
    gologin = await createGoLoginClient();
    const profile = await gologin.resolveProfile();
    if (!wsUrl && (profile.isRunning || await orbitaIsRunning())) {
      console.log(JSON.stringify({ step: "stopping-orphan", runningApi: profile.isRunning }));
      try {
        const { LocalProfileLauncher } = await import("../src/gologin/local.js");
        const gl = new LocalProfileLauncher({ token: process.env.GL_API_TOKEN });
        gl.profileId = profile.profile_id;
        await gl.request("stop", { profileId: profile.profile_id }, 60_000);
        await sleep(3000);
      } catch (error) {
        console.log(JSON.stringify({ step: "stop-orphan-failed", message: error.message }));
      }
    }
    const fresh = await gologin.resolveProfile();
    if (fresh.isRunning) throw new Error("GoLogin profile is already running. Close it first.");
    console.log(JSON.stringify({ step: "starting", profile: fresh.name, running: fresh.isRunning }));
    try {
      ({ wsUrl } = await gologin.startProfile(fresh));
    } catch (error) {
      console.log(JSON.stringify({ step: "start-returned-error", message: error.message }));
      wsUrl = await waitForDebugger(90_000);
      if (!wsUrl) throw error;
    }
    startedByUs = false;
    console.log(JSON.stringify({ step: "started", ws: Boolean(wsUrl) }));
  }
  let browser;
  const results = [];
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null, protocolTimeout: 90_000 });
    const page = await workingPage(browser);
    console.log(JSON.stringify({ step: "tab", url: page.url() }));
    if (!/linkedin\.com\/feed\/?(\?|$)/.test(page.url())) {
      await page.goto(FEED, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await sleep(2500);
    await page.waitForSelector("main, body", { timeout: 20_000 });
    await dismissOverlay(page);
    console.log(JSON.stringify({ step: "feed-ready", url: page.url(), likesVisible: (await inspectTargets(page)).length }));

    const used = new Set();
    let scans = 0;
    while (results.filter((r) => r.confirmed).length < TARGET_LIKES && scans < 24) {
      scans += 1;
      await dismissOverlay(page);
      let targets = await inspectTargets(page);
      let target = targets.find((t) => !used.has(t.href || t.snippet));
      if (!target) {
        await page.mouse.move(480, 360, { steps: 4 }).catch(() => {});
        await page.mouse.wheel({ deltaY: 650 });
        await sleep(1200);
        continue;
      }
      used.add(target.href || target.snippet);
      let scrolled = await scrollLikeIntoView(page, target.href, target.snippet);
      await sleep(500);
      const vh = scrolled?.vh || 900;
      const visible = scrolled && scrolled.top >= 80 && scrolled.bottom <= vh + 8;
      if (scrolled && !visible) {
        await page.mouse.wheel({ deltaY: scrolled.y - Math.round(vh * 0.78) }).catch(() => {});
        await sleep(400);
        scrolled = await runProbe(page, "coords", { href: target.href, snippet: target.snippet });
      }
      if (!scrolled || scrolled.top < 70 || scrolled.top > vh - 24) {
        console.log(JSON.stringify({ step: "skip-offscreen", scrolled, author: target.author, href: target.href }));
        continue;
      }
      const hit = await probeLikePoint(page, scrolled.x, scrolled.y);
      if (!hit?.safe) {
        console.log(JSON.stringify({ step: "skip-unsafe", hit, scrolled, author: target.author, href: target.href }));
        continue;
      }
      const fresh = { ...target, x: scrolled.x, y: scrolled.y, inView: true, hit };
      console.log(JSON.stringify({ step: "clicking", n: results.length + 1, ...fresh }, null, 2));
      await likeAt(page, fresh.x, fresh.y);
      await sleep(2200);
      const openedMedia = await dismissOverlay(page);
      const confirmed = await confirmLike(page, fresh.href, fresh.author, fresh.snippet);
      const row = {
        attempt: results.length + 1,
        href: fresh.href,
        author: fresh.author,
        snippet: fresh.snippet,
        clickedAt: { x: fresh.x, y: fresh.y, top: scrolled.top, bottom: scrolled.bottom, vh },
        openedMedia,
        confirm: confirmed,
        confirmed: Boolean(confirmed.liked) && !openedMedia,
      };
      results.push(row);
      console.log(JSON.stringify({ step: "result", ...row }, null, 2));
      await sleep(2500);
    }
  } finally {
    try { await browser?.disconnect(); } catch { /* already gone */ }
    if (startedByUs && gologin) {
      try { await gologin.stopProfile(); }
      catch (error) { console.error(`stop failed: ${error.message}`); }
    }
  }
  const ok = results.filter((r) => r.confirmed).length;
  console.log(JSON.stringify({ summary: { attempted: results.length, confirmed: ok, results } }, null, 2));
  if (ok < TARGET_LIKES) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
