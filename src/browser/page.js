export async function foregroundPage(page) {
  const cdp = await page.createCDPSession();
  try {
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
  } finally {
    await cdp.detach().catch(() => {});
  }
}
