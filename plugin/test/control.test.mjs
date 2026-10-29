import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { PageControl } from "../src/control.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error(description);
}

// CDP inspection can see closed roots; ordinary page scripts and the accessibility tree cannot.
async function controlNode(session, className) {
  const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
  function visit(node) {
    const attributes = node.attributes || [];
    if (
      attributes.some(
        (value, index) => index % 2 === 0 && value === "class" && attributes[index + 1].split(" ").includes(className),
      )
    )
      return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }
  const node = visit(root);
  assert.ok(node, `Control node ${className} must exist`);
  return node;
}

async function inspect(session, className, functionDeclaration) {
  const node = await controlNode(session, className);
  const { object } = await session.send("DOM.resolveNode", { nodeId: node.nodeId });
  try {
    const result = await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  } finally {
    await session.send("Runtime.releaseObject", { objectId: object.objectId });
  }
}

test(
  "page control stays private, passes page input, follows real mouse, restores navigation and cleans up",
  { timeout: 45000 },
  async () => {
    const executablePath = [
      process.env.SNOW_TEST_BROWSER,
      path.join(homedir(), ".cache/puppeteer/chrome/win64-131.0.6778.204/chrome-win64/chrome.exe"),
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((candidate) => candidate && existsSync(candidate));
    assert.ok(executablePath, "An installed test Chromium is required; this fixture creates its own browser/profile.");
    const fixture = http.createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/csp") response.setHeader("content-security-policy", "script-src 'none'; style-src 'none'");
      response.end(
        '<title>Control fixture</title><button style="position:fixed;left:30px;top:100px;width:130px;height:40px" onclick="this.textContent=\'Clicked\'">Underlying button</button>',
      );
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    let browser, control, leased;
    try {
      browser = await chromium.launch({ executablePath, headless: true });
      const context = await browser.newContext({ viewport: { width: 900, height: 650 } });
      const page = await context.newPage();
      const other = await context.newPage();
      const url = `http://127.0.0.1:${fixture.address().port}`;
      await page.goto(url);
      await other.goto(url);
      let stops = 0;
      control = await PageControl.create(page, {
        generation: "generation-one",
        displayNumber: 1,
        onStop: () => {
          stops++;
        },
      });
      const session = control.session;
      assert.deepEqual(
        await inspect(
          session,
          "instance-number",
          "function(){const s=getComputedStyle(this);return [this.textContent,s.backgroundColor,s.color,s.borderRadius]}",
        ),
        ["编号 1", "rgb(37, 99, 235)", "rgb(255, 255, 255)", "999px"],
      );
      assert.equal(await page.locator("[data-cdphelper-control]").count(), 1);
      assert.equal(await other.locator("[data-cdphelper-control]").count(), 0, "Uncontrolled pages get no overlay");
      assert.equal(await page.evaluate(() => document.querySelector("[data-cdphelper-control]").shadowRoot), null);
      assert.equal(
        await page.evaluate((binding) => typeof globalThis[binding], control.binding),
        "undefined",
        "Binding is unavailable in the main world",
      );
      assert.doesNotMatch(await page.locator("body").ariaSnapshot(), /cdpHelper|停止控制|正在控制/);
      assert.equal(
        await inspect(session, "pointer", "function(){return getComputedStyle(this).display}"),
        "none",
        "Binding does not invent mouse coordinates",
      );
      await page.mouse.move(70, 110);
      assert.equal(
        await inspect(session, "pointer", "function(){return getComputedStyle(this).display}"),
        "none",
        "Human movement while idle must not be presented as an AI action",
      );
      await control.update({ action: "正在点击" });
      await page.mouse.click(90, 120);
      await page.getByRole("button", { name: "Clicked", exact: true }).waitFor();
      assert.deepEqual(await inspect(session, "pointer", "function(){return [this.style.left,this.style.top]}"), [
        "90px",
        "120px",
      ]);
      await control.update({ action: "读取页面", box: { x: 30, y: 100, width: 130, height: 40 } });
      assert.equal(await inspect(session, "action", "function(){return this.textContent}"), "读取页面");
      assert.deepEqual(
        await inspect(
          session,
          "target",
          "function(){return [this.style.left,this.style.top,this.style.width,this.style.height]}",
        ),
        ["30px", "100px", "130px", "40px"],
      );
      assert.deepEqual(
        await inspect(session, "pointer", "function(){return [this.style.left,this.style.top]}"),
        ["90px", "120px"],
        "A status update must not move the mouse marker",
      );
      await inspect(session, "stop", "function(){this.click();return true}");
      assert.equal(stops, 0, "Synthetic stop clicks are ignored");
      await session.send("Runtime.evaluate", {
        contextId: control.contextId,
        expression: `${control.binding}(${JSON.stringify(JSON.stringify({ token: control.token, generation: "stale-generation", action: "stop" }))})`,
      });
      await session.send("Runtime.evaluate", {
        contextId: control.contextId,
        expression: `${control.binding}(${JSON.stringify(JSON.stringify({ token: "forged", generation: control.generation, action: "stop" }))})`,
      });
      assert.equal(stops, 0, "A binding name alone cannot forge the generation or token");
      await page.evaluate(() => document.querySelector("[data-cdphelper-control]").remove());
      await until(
        () =>
          page
            .locator("[data-cdphelper-control]")
            .count()
            .then((count) => count === 1),
        "Removed overlay must recover",
      );
      await page.goto(`${url}/next`);
      await control.ensure();
      assert.equal(await page.locator("[data-cdphelper-control]").count(), 1);
      assert.equal(await inspect(session, "pointer", "function(){return getComputedStyle(this).display}"), "none");
      await control.ensure();
      assert.equal(await page.locator("[data-cdphelper-control]").count(), 1, "Ensure is idempotent");
      await control.dispose();
      await control.dispose();
      assert.equal(await page.locator("[data-cdphelper-control]").count(), 0);
      await page.goto(`${url}/disposed`);
      await pause(150);
      assert.equal(
        await page.locator("[data-cdphelper-control]").count(),
        0,
        "Disposed new-document scripts cannot resurrect controls",
      );

      await page.goto(`${url}/csp`);
      control = await PageControl.create(page, {
        generation: "generation-two",
        onStop: () => {
          stops++;
        },
      });
      assert.match(
        await inspect(control.session, "bar", "function(){return getComputedStyle(this).backgroundImage}"),
        /linear-gradient/,
        "Page CSP must not remove control styling",
      );
      const stopBox = await inspect(
        control.session,
        "stop",
        "function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}",
      );
      await page.mouse.click(stopBox.x, stopBox.y);
      await until(() => stops === 1, "Trusted stop must immediately notify its owner");
      assert.equal(await page.locator("[data-cdphelper-control]").count(), 0);
      await assert.rejects(control.update({ action: "late update" }), /no longer active/);
      await control.dispose();

      leased = await PageControl.create(page, { generation: "orphan-lease", onStop: () => {} });
      clearInterval(leased.timer); // Simulate the broker disappearing without a disposal handshake.
      await until(
        () =>
          page
            .locator("[data-cdphelper-control]")
            .count()
            .then((count) => count === 1),
        "Lease overlay must mount",
      );
      await pause(16500);
      assert.equal(
        await page.locator("[data-cdphelper-control]").count(),
        0,
        "Orphaned control expires without continuous animation",
      );
      await leased.dispose();
    } finally {
      await control?.dispose();
      await leased?.dispose();
      await browser?.close();
      await new Promise((resolve) => fixture.close(resolve));
    }
  },
);
