import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

function isModCDP(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return (
      pkg.name === "modcdp" &&
      typeof pkg.scripts?.["proxy-existing"] === "string" &&
      (existsSync(path.join(dir, "js/src/proxy/cli.ts")) || existsSync(path.join(dir, "dist/js/src/proxy/cli.js")))
    );
  } catch {
    return false;
  }
}

function findRepo(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!isModCDP(dir)) throw new Error(`不是可用的 ModCDP 仓库：${dir}`);
    return dir;
  }
  for (const start of [process.cwd(), path.dirname(fileURLToPath(import.meta.url))]) {
    let dir = start;
    while (true) {
      if (isModCDP(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("找不到 ModCDP 仓库；请传入 --repo <仓库绝对路径> 或提供 MODCDP_ROOT。");
}

async function listPages({ context }) {
  const pages = [];
  for (const page of context.pages()) {
    if (!/^https?:\/\//i.test(page.url())) continue;
    let timer;
    try {
      const title = await Promise.race([
        page.title(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("读取页面标题超时")), 5_000);
        }),
      ]);
      pages.push({ url: page.url(), title });
    } catch (error) {
      pages.push({ url: page.url(), title: null, error: error.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return { pages };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      endpoint: { type: "string", default: "http://127.0.0.1:9223" },
      task: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "Usage: node run.mjs [--repo <ModCDP root>] [--endpoint <CDP URL>] [--task <task.mjs>]\n" +
        "Without --task: list existing HTTP/HTTPS pages. A task must export default async ({ browser, context }) => result.\n" +
        "Repo lookup: --repo, MODCDP_ROOT, cwd ancestors, skill ancestors. No browser is launched.",
    );
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("需要 Node >= 22。");
  const repo = findRepo(values.repo ?? process.env.MODCDP_ROOT);
  const requireFromRepo = createRequire(path.join(repo, "package.json"));
  let chromium;
  try {
    const { version } = requireFromRepo("playwright/package.json");
    const [major, minor] = version.split(".").map(Number);
    if (major < 1 || (major === 1 && minor < 60)) throw new Error(`当前 Playwright ${version}，需要 >= 1.60。`);
    ({ chromium } = requireFromRepo("playwright"));
  } catch (error) {
    throw new Error(`无法从 ${repo} 加载 Playwright；请检查开发依赖与版本。${error.message}`);
  }
  const task = values.task ? (await import(pathToFileURL(path.resolve(values.task)).href)).default : listPages;
  if (typeof task !== "function") throw new Error("任务文件必须默认导出 async function ({ browser, context })。");

  let browser;
  try {
    browser = await chromium.connectOverCDP(values.endpoint, { noDefaults: true, timeout: 15_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("代理未返回已有浏览器的默认 context；请检查雪诺扩展连接。");
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    const result = await task({ browser, context });
    console.log(JSON.stringify(result ?? { ok: true }, null, 2));
  } finally {
    // For a connectOverCDP connection this disconnects the client, not the user's browser.
    await browser?.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
