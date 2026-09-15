export async function foregroundPage(page, { timeoutMs = 8_000 } = {}) {
  let cdp = null;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    // Detach immediately so a hung Target/Browser command cannot occupy the
    // page session and wedge later Runtime.callFunctionOn for protocolTimeout.
    cdp?.detach().catch(() => {});
    cdp = null;
  }, timeoutMs);

  try {
    cdp = await page.createCDPSession();
    try {
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
      // Local fullscreen Orbita can be on another macOS Space. Cloud Browser has
      // no desktop window, so these window-management commands may be unavailable.
      if (["fullscreen", "minimized"].includes(bounds.windowState)) {
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      }
    } catch {
      // Headless/cloud targets still support bringToFront without window bounds.
    }
    await page.bringToFront();
  } catch {
    await page.bringToFront().catch(() => {});
  } finally {
    settled = true;
    clearTimeout(timer);
    await cdp?.detach().catch(() => {});
  }
}
