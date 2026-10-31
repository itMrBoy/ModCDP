const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function bounded(operation, timeout) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Viewport capture timed out.")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Keep capture on the exact owned Page through Playwright's existing connection.
// Chromium can stall hidden surfaces when a viewport clip temporarily resizes
// the view. An unclipped surface capture avoids that path and still captures
// only the viewport. Never activate the tab or capture the active desktop tab.
export async function screenshotPage(page, guard) {
  let session;
  try {
    guard();
    session = await page.context().newCDPSession(page);
    guard();
    const { data } = await bounded(
      session.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      5000,
    );
    guard();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    guard();
    const png = Buffer.from(data, "base64");
    // The surface's physical scale can differ from JS devicePixelRatio when
    // another debugger set device metrics. Require the viewport's proportions,
    // allowing native pixel density without accepting a full-page image.
    if (
      png.length < 24 ||
      !png.subarray(0, 8).equals(PNG) ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      png.readUInt32BE(16) <= 0 ||
      Math.abs(png.readUInt32BE(20) - (viewport.height * png.readUInt32BE(16)) / viewport.width) > 1
    )
      throw new Error(
        `Native screenshot ${png.length >= 24 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "invalid PNG"} did not match viewport ${viewport.width}x${viewport.height}.`,
      );
    return png.toString("base64");
  } catch (nativeError) {
    guard();
    // Keep Playwright's regular viewport path for engines with different
    // surface sizing. Failure stays explicit; neither path requests focus.
    try {
      const image = await page.screenshot({ timeout: 10000 });
      guard();
      return image.toString("base64");
    } catch (error) {
      throw new Error(
        `Viewport screenshot failed. Surface capture: ${nativeError.message}; Playwright: ${error.message}`,
        { cause: error },
      );
    }
  } finally {
    await session?.detach().catch(() => {});
  }
}
