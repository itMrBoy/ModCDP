// MODCDP_TS_ONLY_TEST: Real extension/browser and sequential CDP clients.
// NO MOCKING, NO MONKEY PATCHING, NO SIMULATING, NO FAKING, NO SKIPPING ALLOWED.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import http from "node:http";
import { chromium } from "playwright";
import { test } from "vitest";
import { LocalBrowserLauncher } from "../src/launcher/LocalBrowserLauncher.js";
import { startProxy } from "../src/proxy/proxy.js";
import { WSUpstreamTransport } from "../src/transport/WSUpstreamTransport.js";
import { buildExtensionFixture } from "./helpers.extension.js";

test("existing reverse proxy listens before a browser joins and survives sequential CDP clients", async () => {
  const reverse_port = await LocalBrowserLauncher.freePort();
  const proxy_port = await LocalBrowserLauncher.freePort();
  const extension = await buildExtensionFixture({
    enable_reversews: true,
    reversews_url: `ws://127.0.0.1:${reverse_port}`,
  });
  const proxy = await startProxy({
    proxy_listen_port: proxy_port,
    launcher: { launcher_mode: "none" },
    upstream: { upstream_mode: "reversews", upstream_reversews_bind: `127.0.0.1:${reverse_port}` } as any,
  });
  const launcher = new LocalBrowserLauncher({
    launcher_local_executable_path: process.env.MODCDP_TEST_BROWSER,
    launcher_local_headless: true,
    launcher_local_extra_args: [`--load-extension=${extension.extension_path}`],
  });
  try {
    const socket = connect(reverse_port, "127.0.0.1");
    await once(socket, "connect");
    socket.destroy();
    await launcher.launch();
    for (let round = 0; round < 2; round++) {
      const cdp = new WSUpstreamTransport({ upstream_ws_cdp_url: proxy.url });
      try {
        await cdp.connect();
        assert.equal(await cdp.send("Mod.evaluate", { expression: "1 + 1" }), 2);
      } finally {
        await cdp.close();
      }
      // Let the server observe the WebSocket close before the next client.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await proxy.close();
    await launcher.close();
    await extension.close();
  }
}, 30_000);

test("unmodified Playwright reads existing documents and cross-site frames through the extension CDP endpoint", async () => {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      req.url === "/child"
        ? "<html><body>child document</body></html>"
        : `<html><title>Existing document</title><body><h1>Existing document</h1><iframe src="http://localhost:${(site.address() as import("node:net").AddressInfo).port}/child"></iframe></body></html>`,
    );
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const url = `http://127.0.0.1:${(site.address() as import("node:net").AddressInfo).port}/`;
  const reverse_port = await LocalBrowserLauncher.freePort();
  const extension = await buildExtensionFixture({
    enable_reversews: true,
    reversews_url: `ws://127.0.0.1:${reverse_port}`,
  });
  const proxy = await startProxy({
    proxy_listen_port: await LocalBrowserLauncher.freePort(),
    launcher: { launcher_mode: "none" },
    upstream: { upstream_mode: "reversews", upstream_reversews_bind: `127.0.0.1:${reverse_port}` } as any,
  });
  const launcher = new LocalBrowserLauncher({
    launcher_local_executable_path: process.env.MODCDP_TEST_BROWSER,
    launcher_local_headless: true,
    launcher_local_extra_args: [`--load-extension=${extension.extension_path}`, "--site-per-process"],
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const watchdog = setTimeout(() => {
    void browser?.close();
  }, 45_000);
  try {
    const launched = await launcher.launch();
    // Native CDP is used only to prepare the independent test browser. All
    // acceptance assertions below connect exclusively to the extension proxy.
    const setup = await chromium.connectOverCDP(launched.cdp_url!);
    try {
      await setup.contexts()[0]!.pages()[0]!.goto(url);
    } finally {
      await setup.close();
    }
    for (let round = 0; round < 2; round++) {
      browser = await chromium.connectOverCDP(proxy.url, { noDefaults: true, timeout: 15_000 });
      const page = browser
        .contexts()[0]!
        .pages()
        .find((p) => p.url() === url);
      assert.ok(page, "The original document must be discovered");
      page.setDefaultTimeout(10_000);
      assert.equal(await page.evaluate(() => 1 + 1), 2);
      assert.equal(await page.locator("h1").innerText(), "Existing document");
      assert.equal(await page.frameLocator("iframe").locator("body").innerText(), "child document");
      assert.ok((await page.screenshot()).length > 100);
      const session = await page.context().newCDPSession(page);
      await session.send("Performance.enable");
      assert.ok((await session.send("Performance.getMetrics")).metrics.length > 0);
      await session.detach();
      if (round === 0) {
        const extra = await page.context().newPage();
        await extra.goto(`${url}second`);
        assert.equal(await extra.locator("h1").innerText(), "Existing document");
        await extra.close();
        assert.equal(await page.title(), "Existing document");
      }
      await browser.close();
      browser = undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        (launched.proc as import("node:child_process").ChildProcess).exitCode,
        null,
        "Disconnect must keep the existing browser alive",
      );
    }
  } finally {
    clearTimeout(watchdog);
    await browser?.close();
    await proxy.close();
    await launcher.close();
    await extension.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
}, 60_000);
