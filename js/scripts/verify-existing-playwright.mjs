// Live acceptance probe. No Mod.* calls, browser patches, or document writes.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const endpoint = process.argv[2] ?? "http://127.0.0.1:9223";
const match = process.argv[3] ?? "snowtech.feishu.cn/";
const output = await mkdtemp(path.join(tmpdir(), "modcdp-playwright-acceptance-"));
const report = { endpoint, match, startedAt: new Date().toISOString(), stages: [], output };
let browser;
let session;
const watchdog = setTimeout(() => {
  void browser?.close();
}, 60_000);
async function check(name, run) {
  report.currentStage = name;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  try {
    const result = await run();
    report.stages.push({ name, ok: true, result });
    return result;
  } catch (error) {
    report.stages.push({ name, ok: false, error: String(error) });
    throw error;
  }
}
try {
  await check("connectOverCDP", async () => {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000, noDefaults: true });
    return { version: browser.version(), contexts: browser.contexts().length };
  });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((page) => page.url().includes(match));
  await check("existing-page", async () => {
    if (!page) {
      const discovery = await browser.newBrowserCDPSession();
      try {
        report.targetDiscovery = await discovery.send("Target.getTargets");
      } finally {
        await discovery.detach();
      }
    }
    assert.ok(page, `No existing tab matches ${match}`);
    return { title: await page.title(), pageCount: pages.length };
  });
  await check("evaluate", async () => {
    const result = await page.evaluate(() => 1 + 1);
    assert.equal(result, 2);
    return result;
  });
  await check("DOM", async () => {
    assert.equal(await page.locator("html").count(), 1);
    return page.evaluate(() => ({
      readyState: document.readyState,
      elements: document.getElementsByTagName("*").length,
    }));
  });
  // Headful Chrome does not paint hidden tabs, so a background tab's screenshot
  // never resolves. Record visibility and keep going to the protocol checks.
  await check("screenshot", async () => {
    const visibility = await page.evaluate(() => document.visibilityState);
    const file = path.join(output, "page.png");
    try {
      const png = await page.screenshot({ path: file, timeout: 10_000 });
      return { file, bytes: png.length, visibility };
    } catch (error) {
      throw new Error(`${error} (document.visibilityState=${visibility})`);
    }
  }).catch(() => {});
  session = await page.context().newCDPSession(page);
  // Report these separately: a missing optional capability must remain visible.
  for (const [name, run] of [
    [
      "Performance",
      async () => {
        await session.send("Performance.enable");
        return session.send("Performance.getMetrics");
      },
    ],
    [
      "CPU-profile",
      async () => {
        await session.send("Profiler.enable");
        let running = false;
        try {
          await session.send("Profiler.start");
          running = true;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const { profile } = await session.send("Profiler.stop");
          running = false;
          const file = path.join(output, "cpu-profile.json");
          await writeFile(file, JSON.stringify(profile));
          return { file, nodes: profile.nodes.length };
        } finally {
          if (running) await session.send("Profiler.stop").catch(() => {});
          await session.send("Profiler.disable").catch(() => {});
        }
      },
    ],
    [
      "Trace",
      async () => {
        const events = [];
        const onData = (data) => events.push(...data.value);
        session.on("Tracing.dataCollected", onData);
        let timer;
        let onComplete;
        let started = false;
        try {
          await session.send("Tracing.start", {
            categories: "devtools.timeline,v8.execute,blink.user_timing",
            transferMode: "ReportEvents",
          });
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const complete = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 10_000);
            onComplete = () => resolve(true);
            session.once("Tracing.tracingComplete", onComplete);
          });
          await session.send("Tracing.end");
          started = false;
          assert.ok(await complete, "Tracing.tracingComplete timed out");
          const file = path.join(output, "trace.json");
          await writeFile(file, JSON.stringify({ traceEvents: events }));
          return { file, events: events.length };
        } finally {
          if (started) await session.send("Tracing.end").catch(() => {});
          clearTimeout(timer);
          if (onComplete) session.off("Tracing.tracingComplete", onComplete);
          session.off("Tracing.dataCollected", onData);
        }
      },
    ],
  ]) {
    await check(name, run).catch(() => {});
  }
} catch (error) {
  console.error(String(error));
} finally {
  clearTimeout(watchdog);
  await session?.detach().catch(() => {});
  // connectOverCDP's browser.close() closes its transport, not the remote browser.
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  delete report.currentStage;
  const accessStages = ["connectOverCDP", "existing-page", "evaluate", "DOM", "screenshot"];
  report.accessOk = accessStages.every((name) => report.stages.some((stage) => stage.name === name && stage.ok));
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.stages.some((stage) => !stage.ok)) process.exitCode = 1;
}
