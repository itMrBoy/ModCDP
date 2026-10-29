// Manual acceptance against the installed Snow browser. Never substitutes Chromium.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import http from "node:http";

const mode = process.argv[2];
if (!["reuse", "isolated"].includes(mode))
  throw new Error("Choose explicitly: node plugin/scripts/verify-snow.mjs reuse|isolated");
const home = path.resolve(".llmdoc-tmp/cdphelper-plugin-acceptance");
await mkdir(home, { recursive: true });
let questionNumber = 0;
const input = process.argv.includes("--file-control")
  ? {
      async question(prompt) {
        const file = path.join(home, `answer-${++questionNumber}.txt`);
        console.log(`${prompt} Response file: ${file}`);
        for (;;) {
          try {
            const value = await readFile(file, "utf8");
            await unlink(file);
            return value.trim();
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await delay(1000);
        }
      },
      close() {},
    }
  : createInterface({ input: process.stdin, output: process.stdout });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/plugin-marketplace/plugins/cdphelper/launch.mjs"), "--home", home],
  stderr: "inherit",
});
const client = new Client({ name: "snow-manual-acceptance", version: "0.1.0" });
const report = { mode, started_at: new Date().toISOString(), checks: {} };
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.find((c) => c.type === "text")?.text);
  if (result.content[0]?.type === "image") return result.content[0];
  return JSON.parse(result.content.find((c) => c.type === "text").text);
}
const fixture = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<title>Snow plugin acceptance</title><h1>Snow plugin acceptance</h1><label>Name<input aria-label="Name"></label><button id="apply">Apply</button><output></output><script>document.querySelector('#apply').onclick=()=>document.querySelector('output').textContent=document.querySelector('input').value</script>`,
  );
});
try {
  await client.connect(transport);
  report.checks.before_selection = await call("browser_status");
  console.log(JSON.stringify(report.checks.before_selection, null, 2));
  let selection = { mode };
  if (mode === "reuse") {
    const id = await input.question(
      "Choose an existing instance_id from browser_status (refresh extension connections first if empty): ",
    );
    selection.instance_id = id.trim();
  }
  report.setup = await call("browser_select", selection);
  await writeFile(path.join(home, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.setup, null, 2));
  const loaded = await input.question(
    "Download the matching cdpHelper Release ZIP separately, unzip it and load its extension/ directory in the target Snow window (or enable its profile-distributed extension). Verify the extension short ID matches browser_status. Enter loaded to verify, or retain to stop: ",
  );
  if (loaded.trim() === "loaded") {
    report.checks.connected_inventory = await call("browser_status");
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    report.checks.tabs = await call("browser_tabs");
    const tab = await call("browser_new_tab");
    await call("browser_navigate", { ...tab, url: `http://127.0.0.1:${fixture.address().port}/` });
    await call("browser_fill", { ...tab, target: { label: "Name" }, value: "Snow Playwright verified" });
    await call("browser_click", { ...tab, target: { role: "button", name: "Apply" } });
    report.checks.snapshot = await call("browser_snapshot", tab);
    if (!report.checks.snapshot.snapshot.includes("Snow Playwright verified"))
      throw new Error("Form result verification failed");
    const screenshot = await call("browser_screenshot", tab);
    await writeFile(path.join(home, "screenshot.png"), Buffer.from(screenshot.data, "base64"));
    report.checks.screenshot = true;
    await call("browser_release", tab);
    console.log("Snow page navigation, reading, fill, click, screenshot: passed.");
  }
  if (mode === "isolated") {
    const close = await input.question(
      "Close and clean ONLY this plugin-created isolated instance? Enter yes to confirm; anything else retains it: ",
    );
    report.finish = await call("browser_finish", {
      close_and_cleanup: close.trim() === "yes",
      confirmed_by_user: true,
    });
  }
  report.status = await call("browser_status");
} catch (error) {
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(home, "report.json"), JSON.stringify(report, null, 2));
  input.close();
  await client.close();
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  console.log(`Report: ${path.join(home, "report.json")}. Abnormal exits retain isolated browsers and profiles.`);
}
