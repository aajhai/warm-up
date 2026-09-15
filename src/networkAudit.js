import { acquireLock } from "./lock.js";
import { loadState, saveState } from "./sessionState.js";
import { openWarmupBrowser } from "./browser/session.js";
import { getWorkingPage } from "./scenario/linkedinFeed.js";
import { inspectAccount, pauseForAccount } from "./scenario/accountGuard.js";
import { networkDom } from "./scenario/linkedinNetwork.js";
import { notify } from "./notifications/slack.js";
import { sleep } from "./util/random.js";

export async function auditNetwork() {
  const release = acquireLock("browser");
  let session;
  let retainLock = false;
  try {
    const state = loadState();
    if (state.pause) throw new Error(`Profile paused: ${state.pause.reason}`);
    session = await openWarmupBrowser();
    const page = await getWorkingPage(session.browser);
    const blockBefore = await inspectAccount(page);
    if (blockBefore && blockBefore.kind !== "unexpected_page") {
      pauseForAccount(state, blockBefore);
      saveState(state);
      throw new Error(blockBefore.reason);
    }
    await page.goto("https://www.linkedin.com/mynetwork/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(5000);
    const block = await inspectAccount(page);
    if (block) {
      pauseForAccount(state, block);
      saveState(state);
      throw new Error(block.reason);
    }
    const candidates = await networkDom(page, "inspect");
    const result = { recognizedSuggestions: candidates.length, clicks: 0, connectionRequests: 0 };
    console.log(JSON.stringify(result));
    notify("network_audit", "Read-only inspection of My Network completed.", result);
    if (!candidates.length) throw new Error("No unambiguous Connect controls found; live connection flow needs inspection.");
  } catch (error) {
    retainLock ||= Boolean(error.retainBrowserLock);
    throw error;
  } finally {
    try { if (session) { await session.browser.disconnect().catch(() => {}); await session.stop(); } }
    catch (error) { retainLock = true; throw error; }
    finally { if (!retainLock) release(); }
  }
}
