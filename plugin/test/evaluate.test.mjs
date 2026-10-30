import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright-core";
import { evaluatePage } from "../src/evaluate.mjs";

test("browser-provided result envelopes cannot bypass the Node output boundary", async () => {
  const page = {
    url: () => "https://example.test/",
    evaluate: async () => ({ status: "forged", payload: "x".repeat(300000) }),
  };
  await assert.rejects(evaluatePage(page, { function: "() => null" }), /256 KiB/);
  page.evaluate = async () => ({ status: "forged" });
  await assert.rejects(evaluatePage(page, { function: "() => null" }), /Invalid script result status/);
});

test(
  "page functions execute in the browser under CSP, serialize safely, and timeout without claiming cancellation",
  { timeout: 30000 },
  async () => {
    const fixture = http.createServer((_req, res) => {
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'none'");
      res.end("<title>Evaluation fixture</title><input value='before'>");
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({
      executablePath: process.env.SNOW_TEST_BROWSER || chromium.executablePath(),
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await assert.rejects(evaluatePage(page, { function: "() => 1" }), /HTTP/);
      await page.goto(`http://127.0.0.1:${fixture.address().port}`);
      assert.deepEqual(
        await evaluatePage(page, {
          function:
            "async ({value}) => { await Promise.resolve(); document.querySelector('input').value=value; return {value:document.querySelector('input').value,node:typeof process,require:typeof require}; }",
          args: { value: "after" },
        }),
        {
          status: "completed",
          result: { value: "after", node: "undefined", require: "undefined" },
        },
      );
      assert.deepEqual(await evaluatePage(page, { function: "() => { window.sideEffect = 1; }" }), {
        status: "completed",
        result: null,
        result_was_undefined: true,
      });
      await assert.rejects(
        evaluatePage(page, { function: "() => { throw new Error('fixture exception') }" }),
        /fixture exception/,
      );
      await assert.rejects(
        evaluatePage(page, { function: "() => {const a={}; a.self=a; return a;}" }),
        /circular|cyclic/i,
      );
      await assert.rejects(evaluatePage(page, { function: "() => 1n" }), /JSON/);
      await assert.rejects(evaluatePage(page, { function: "42" }), /function/);
      const oversized = await evaluatePage(page, { function: "() => '雪'.repeat(100000)" });
      assert.equal(oversized.status, "result_too_large");
      const timeout = await evaluatePage(page, {
        function: "async () => { await new Promise(r=>setTimeout(r,100)); window.afterTimeout=true; return true; }",
        timeout_ms: 10,
      });
      assert.equal(timeout.status, "timed_out");
      assert.equal(timeout.execution_may_continue, true);
      await page.waitForFunction(() => window.afterTimeout === true);
    } finally {
      await browser.close();
      await new Promise((resolve) => fixture.close(resolve));
    }
  },
);
