import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { randomUUID, randomBytes } from "node:crypto";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(message);
}

async function profileState(context) {
  try {
    const worker = context.serviceWorkers()[0];
    if (!worker) return null;
    return await worker.evaluate(async () => ({
      state: (await chrome.storage.session.get("snowBridgeState")).snowBridgeState,
      badge: await chrome.action.getBadgeText({}),
      title: await chrome.action.getTitle({}),
    }));
  } catch {
    // Reads can race the old worker closing during a deliberate extension reload.
    return null;
  }
}

test(
  "same extension in multiple profiles: explicit routing, ownership, parallel operations and reconnect invalidation",
  { timeout: 120000 },
  async () => {
    const executablePath = [
      process.env.SNOW_TEST_BROWSER,
      path.join(homedir(), ".cache/puppeteer/chrome/win64-131.0.6778.204/chrome-win64/chrome.exe"),
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((p) => p && existsSync(p));
    assert.ok(
      executablePath,
      "Set SNOW_TEST_BROWSER to an installed extension-capable Chromium. Real Snow acceptance is separate.",
    );
    const scratch = await mkdtemp(path.join(tmpdir(), "snow-multipeer-fixture-"));
    const bundled = path.resolve(".llmdoc-tmp/plugin-tests/broker.mjs");
    await mkdir(path.dirname(bundled), { recursive: true });
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
    const release = JSON.parse(await readFile("dist/releases/release-manifest.json", "utf8"));
    const broker = new BrowserBroker({
      home: path.join(scratch, "home"),
      extensionId: release.extension.expected_extension_id,
      extensionVersion: release.extension_version,
      bridgePort: 0,
      // The late-init record below represents an owned process fixture, not Snow acceptance.
      checkIsolated: async () => true,
    });
    const fixture = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>Snow fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Apply</button><output></output><button id="late" hidden>Late</button>`,
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const contexts = [];
    try {
      await broker.init();
      const a = broker.createSession(),
        b = broker.createSession(),
        c = broker.createSession();
      await assert.rejects(broker.call(a, "browser_new_tab", {}), /select|choose/i);
      await assert.rejects(broker.call(a, "browser_select", { mode: "reuse" }));
      const extension = path.resolve("dist/extension");
      for (const alias of ["Profile A", "Profile B"]) {
        const context = await chromium.launchPersistentContext(path.join(scratch, alias), {
          executablePath,
          headless: true,
          ignoreDefaultArgs: ["--disable-extensions"],
          args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
          ],
        });
        contexts.push(context);
        // Match manual unpacked-extension installation. Recent Chromium disables
        // a developer extension on reload if the profile's developer mode is off.
        const extensionsPage = await context.newPage();
        await extensionsPage.goto("chrome://extensions");
        const developerMode = extensionsPage.locator("#devMode");
        if (!(await developerMode.evaluate((toggle) => toggle.checked))) await developerMode.click();
        assert.equal(await developerMode.evaluate((toggle) => toggle.checked), true);
        await extensionsPage.close();
        const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
        await until(
          () => worker.evaluate(() => Boolean(chrome.storage?.local)),
          "Extension APIs must be initialized before profile configuration",
        );
        await worker.evaluate(
          async ({ url, alias }) => {
            await chrome.storage.local.set({ snowBridgeUrl: url, snowInstanceName: alias });
            setTimeout(() => chrome.runtime.reload(), 50);
          },
          { url: `ws://127.0.0.1:${broker.bridge.port}/bridge`, alias: "工作浏览器" },
        );
      }
      const inventory = await until(async () => {
        const status = await broker.call(a, "browser_status", {});
        return (
          status.instances.length === 2 && status.instances.every((i) => i.extension_connected) && status.instances
        );
      }, "Both profiles must register independently with the same extension ID");
      const registeredProfiles = await Promise.all(
        contexts.map((context) =>
          until(async () => {
            const value = await profileState(context);
            return value?.state?.connected && value.badge === String(value.state.display_number) && value;
          }, "The toolbar badge must match this profile's current registration before selection"),
        ),
      );
      const ia = inventory.find((i) => i.instance_id === registeredProfiles[0].state.instance_id),
        ib = inventory.find((i) => i.instance_id === registeredProfiles[1].state.instance_id);
      assert.ok(ia && ib);
      assert.equal(ia.name, "工作浏览器");
      assert.equal(ib.name, "工作浏览器");
      assert.notEqual(ia.display_number, ib.display_number, "duplicate names must have distinct display numbers");
      for (const [index, instance] of [ia, ib].entries()) {
        assert.equal(broker.instances.get(instance.instance_id).browser, null, "badges do not connect Playwright");
        assert.equal(instance.playwright_connected, false);
        assert.match(registeredProfiles[index].title, new RegExp(`工作浏览器 · 编号 ${instance.display_number}`));
        const options = await contexts[index].newPage();
        await options.goto(`chrome-extension://${release.extension.expected_extension_id}/options.html`);
        const status = await options.locator("#cdphelper-status").innerText();
        assert.ok(status.includes(`工作浏览器 · 编号 ${instance.display_number}`));
        assert.ok(!status.includes(instance.short_id), "user-facing status must not require the random short ID");
        await options.close();
      }
      assert.notEqual(ia.instance_id, ib.instance_id);
      assert.notEqual(ia.short_id, ib.short_id);
      assert.equal(
        (await broker.call(a, "browser_status", {})).selected,
        null,
        "registration must not select implicitly",
      );
      await broker.call(a, "browser_select", { mode: "reuse", instance_id: ia.instance_id });
      await broker.call(b, "browser_select", { mode: "reuse", instance_id: ib.instance_id });
      await broker.call(c, "browser_select", { mode: "reuse", instance_id: ia.instance_id });
      assert.equal((await fetch(broker.instances.get(ia.instance_id).proxy.url + "/json/version")).status, 403);
      const first = await broker.call(a, "browser_new_tab", {});
      const second = await broker.call(b, "browser_new_tab", {});
      const third = await broker.call(c, "browser_new_tab", {});
      const url = `http://127.0.0.1:${fixture.address().port}/`;
      await Promise.all([
        broker.call(a, "browser_navigate", { ...first, url }),
        broker.call(b, "browser_navigate", { ...second, url }),
        broker.call(c, "browser_navigate", { ...third, url }),
      ]);
      await assert.rejects(broker.call(c, "browser_bind", first), /busy/);
      await assert.rejects(broker.call(b, "browser_bind", first), /Invalid|different|expired/i);
      await assert.rejects(
        broker.call(c, "browser_fill", { ...first, target: { label: "Name" }, value: "forged" }),
        /not bound/,
      );
      const original = contexts[0].pages().find((p) => p.url() === url);
      await original.evaluate(() =>
        setTimeout(() => {
          document.querySelector("#late").hidden = false;
        }, 1500),
      );
      let waited = false;
      const waiting = broker
        .call(a, "browser_wait", { ...first, target: { selector: "#late" }, timeout_ms: 5000 })
        .then(() => {
          waited = true;
        });
      await broker.call(b, "browser_fill", { ...second, target: { label: "Name" }, value: "other-profile" });
      await broker.call(c, "browser_fill", { ...third, target: { label: "Name" }, value: "same-profile-parallel" });
      assert.equal(waited, false, "one session's wait must not block other instances or tabs");
      await waiting;
      await broker.call(b, "browser_click", { ...second, target: { role: "button", name: "Apply" } });
      assert.match((await broker.call(b, "browser_snapshot", second)).snapshot, /other-profile/);
      assert.ok(Buffer.from((await broker.call(b, "browser_screenshot", second)).image, "base64").length > 100);
      await broker.dropSession(a);
      await broker.call(c, "browser_bind", first);
      const worker = contexts[0].serviceWorkers()[0];
      await worker.evaluate(() => {
        setTimeout(() => chrome.runtime.reload(), 50);
      });
      const replacement = await until(async () => {
        const status = await broker.call(c, "browser_status", {});
        return status.instances.find(
          (i) => i.instance_id !== ia.instance_id && i.instance_id !== ib.instance_id && i.extension_connected,
        );
      }, "Reloaded extension must register a new instance ID");
      assert.ok(replacement.display_number > Math.max(ia.display_number, ib.display_number));
      await until(async () => {
        const value = await profileState(contexts[0]);
        return value?.badge === String(replacement.display_number);
      }, "A reloaded profile must show the new display number, not its old badge");
      const after = await broker.call(c, "browser_status", {});
      assert.notEqual(after.selected, replacement.instance_id, "reconnection must not silently rebind a session");
      await assert.rejects(broker.call(c, "browser_snapshot", first), /expired|attached|select|disconnected/i);
      assert.match(
        (await broker.call(b, "browser_snapshot", second)).snapshot,
        /other-profile/,
        "other profile remains operational",
      );
      await broker.call(c, "browser_select", { mode: "reuse", instance_id: replacement.instance_id });
      await assert.rejects(broker.call(c, "browser_bind", first), /Invalid|expired/i);
      // The service worker may start before Snow opens its initialization URL.
      // Exercise that real ordering without spawning or claiming a real Snow process.
      const stale = await broker.call(c, "browser_new_tab", {});
      const pendingSession = broker.createSession();
      const ownedRecord = {
        instance_id: randomUUID(),
        launch_token: randomBytes(32).toString("hex"),
        creator_session_id: pendingSession,
        initialized: false,
        profile: path.join(scratch, "late-init-fixture-profile"),
        pid: null,
      };
      broker.records.push(ownedRecord);
      Object.assign(broker.session(pendingSession), {
        instance: null,
        pending: ownedRecord.instance_id,
        isolation: ownedRecord.instance_id,
      });
      const initializationTab = await contexts[0].newPage();
      await initializationTab.goto(`http://127.0.0.1:${broker.bridge.port}/initialize/${ownedRecord.launch_token}`);
      const ownedInstance = await until(async () => {
        const status = await broker.call(pendingSession, "browser_status", {});
        return status.instances.find((i) => i.owned_instance_id === ownedRecord.instance_id && i.extension_connected);
      }, "An initialization URL opened after worker startup must register the matching isolated instance");
      assert.notEqual(ownedInstance.instance_id, replacement.instance_id);
      assert.equal(ownedInstance.mode, "isolated");
      const matched = await broker.call(pendingSession, "browser_status", {});
      assert.equal(matched.selected, ownedInstance.instance_id);
      assert.equal(matched.pending_isolation, null);
      await assert.rejects(broker.call(c, "browser_snapshot", stale), /expired|attached|select|disconnected/i);
      assert.match((await broker.call(b, "browser_snapshot", second)).snapshot, /other-profile/);
      await pause(500);
      const stable = await broker.call(pendingSession, "browser_status", {});
      assert.equal(
        stable.selected,
        ownedInstance.instance_id,
        "the initialization tab must not cause repeated worker reloads",
      );
      assert.equal(stable.instances.filter((i) => i.owned_instance_id === ownedRecord.instance_id).length, 1);
      await broker.call(pendingSession, "browser_finish", { close_and_cleanup: false, confirmed_by_user: true });
      await broker.close();
      for (const context of contexts) {
        await until(async () => {
          const value = await profileState(context);
          return value?.state?.connected === false && value.badge === "" && value.title.includes("未连接");
        }, "Disconnect must clear the badge while preserving the browser and its pages");
      }
      for (const context of contexts)
        assert.ok(
          context.pages().some((p) => p.url() === url),
          "broker disconnect preserves existing pages",
        );
    } catch (error) {
      for (const [index, context] of contexts.entries()) {
        const workers = context.serviceWorkers();
        const diagnostics = await Promise.all(
          workers.map(async (worker) => {
            try {
              return await Promise.race([
                worker.evaluate(async () => ({
                  url: self.location.href,
                  browser: navigator.userAgent,
                  extension: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version },
                  configuration: await chrome.storage.local.get(["snowBridgeUrl", "snowInstanceName"]),
                  state: await chrome.storage.session.get("snowBridgeState"),
                })),
                pause(2000).then(() => ({ url: worker.url(), unavailable: "worker did not respond" })),
              ]);
            } catch (diagnosticError) {
              return { url: worker.url(), unavailable: String(diagnosticError) };
            }
          }),
        );
        console.error(`Profile ${index + 1} extension diagnostics: ${JSON.stringify(diagnostics)}`);
        try {
          const manager = await context.newPage();
          await manager.goto("chrome://extensions");
          const extensions = await manager.evaluate(
            () =>
              new Promise((resolve) => {
                chrome.developerPrivate.getExtensionsInfo(
                  { includeDisabled: true, includeTerminated: true },
                  (entries) =>
                    resolve(
                      entries.map(({ id, state, disableReasons, manifestErrors, runtimeErrors }) => ({
                        id,
                        state,
                        disableReasons,
                        manifestErrors,
                        runtimeErrors,
                      })),
                    ),
                );
              }),
          );
          console.error(`Profile ${index + 1} extension manager: ${JSON.stringify(extensions)}`);
        } catch (diagnosticError) {
          console.error(`Profile ${index + 1} extension manager unavailable: ${String(diagnosticError)}`);
        }
      }
      throw error;
    } finally {
      await broker.close();
      await Promise.all(contexts.map((c) => c.close()));
      await new Promise((resolve) => fixture.close(resolve));
      const resolved = path.resolve(scratch);
      assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
      await rm(resolved, { recursive: true, force: true });
    }
  },
);
