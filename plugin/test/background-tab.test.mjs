import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const bundled = path.resolve(".llmdoc-tmp/plugin-tests/background-tab-broker.mjs");
await build({
  entryPoints: ["plugin/src/broker.mjs"],
  outfile: bundled,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { BrowserBroker } = await import(pathToFileURL(bundled).href);

test("background creation skips a closed unrelated page and preserves live target failures", async () => {
  const executablePath = [
    process.env.SNOW_TEST_BROWSER,
    path.join(homedir(), ".cache/puppeteer/chrome/win64-131.0.6778.204/chrome-win64/chrome.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => p && existsSync(p));
  assert.ok(executablePath, "Set SNOW_TEST_BROWSER to an installed Chromium; real Snow acceptance is separate.");
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  const broker = new BrowserBroker({
    home: path.resolve(".llmdoc-tmp/background-tab-home"),
    controlFactory: async () => ({ ensure: async () => {}, dispose: async () => {} }),
  });
  const owner = broker.createSession(),
    instance = randomUUID();
  broker.session(owner).instance = instance;
  broker.context = async () => context;
  let actual,
    unrelated,
    failTarget = false,
    closeDuringProbe = false,
    failLiveDetach = false,
    closedDetachAttempts = 0;
  const nativeSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (page) => {
    if (failTarget && page === actual) throw new Error("requested target session failed");
    if (closeDuringProbe && page === unrelated) {
      return {
        send: async () => {
          await page.close();
          throw new Error("candidate closed during target lookup");
        },
        detach: async () => {
          closedDetachAttempts++;
          throw new Error("closed candidate cannot detach");
        },
      };
    }
    const session = await nativeSession(page);
    if (failLiveDetach && page === actual) {
      const detach = session.detach.bind(session);
      session.detach = async () => {
        await detach();
        throw new Error("live target detach failed");
      };
    }
    return session;
  };
  broker.instances.set(instance, {
    browser: {
      newBrowserCDPSession: async () => ({
        send: async () => {
          unrelated = await context.newPage();
          if (!closeDuringProbe) await unrelated.close();
          actual = await context.newPage();
          const session = await nativeSession(actual);
          try {
            return { targetId: (await session.send("Target.getTargetInfo")).targetInfo.targetId };
          } finally {
            await session.detach();
          }
        },
        detach: async () => {},
      }),
    },
  });
  try {
    const { tab_id } = await broker.call(owner, "browser_new_tab", {});
    assert.equal(broker.tabs.get(tab_id).page, actual);
    assert.equal(broker.tabs.get(tab_id).owner, owner);
    await broker.call(owner, "browser_release", { tab_id });
    closeDuringProbe = true;
    const second = await broker.call(owner, "browser_new_tab", {});
    assert.equal(closedDetachAttempts, 1, "closed candidate detach failure must not reject the page waiter");
    assert.equal(broker.tabs.get(second.tab_id).page, actual);
    await broker.call(owner, "browser_release", { tab_id: second.tab_id });
    closeDuringProbe = false;
    failLiveDetach = true;
    await assert.rejects(broker.call(owner, "browser_new_tab", {}), /live target detach failed/);
    failLiveDetach = false;
    failTarget = true;
    await assert.rejects(broker.call(owner, "browser_new_tab", {}), /requested target session failed/);
    assert.equal(
      [...broker.tabs.values()].some((tab) => tab.page === actual),
      false,
    );
  } finally {
    await broker.dropSession(owner);
    await browser.close();
  }
});
