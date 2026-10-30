import { execFileSync } from "node:child_process";

const sourceURL = "https://github.com/itMrBoy/ModCDP";
const distributionURL = "https://github.com/itMrBoy/cdpHelper";
const relatedPaths = [
  "plugin/",
  "extension/",
  "js/",
  "package.json",
  "pnpm-lock.yaml",
  "README.md",
  "README.zh-CN.md",
  ".github/",
];
const categories = [
  ["新增功能", ["feat"]],
  ["问题修复", ["fix"]],
  ["改进与重构", ["refactor", "perf"]],
  ["文档更新", ["docs"]],
  ["工程与测试", ["build", "ci", "test", "chore"]],
  ["其他更新", []],
];
const markdown = (value) => value.replaceAll("&", "&amp;").replace(/[\\`*_{}[\]()#+.!|<>~]/g, "\\$&");
function git(source, ...args) {
  return execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
function commit(source, value, label) {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error(`Invalid ${label} SHA`);
  if (git(source, "rev-parse", "--verify", `${value}^{commit}`) !== value) throw new Error(`Missing ${label} commit`);
}

export async function releaseNotes({
  source,
  version,
  sourceCommit,
  distributionCommit,
  previousSourceCommit = null,
  previousTag = null,
  assetName,
  artifactSha256,
}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) throw new Error("Invalid release version");
  if (!/^[a-f0-9]{40}$/.test(distributionCommit ?? "")) throw new Error("Invalid distribution SHA");
  if (!/^[a-f0-9]{64}$/.test(artifactSha256 ?? "")) throw new Error("Invalid artifact SHA256");
  if (assetName !== `cdphelper-extension-v${version}.zip`) throw new Error("Invalid extension asset name");
  if (previousTag !== null && !/^v\d+\.\d+\.\d+$/.test(previousTag)) throw new Error("Invalid previous release tag");
  commit(source, sourceCommit, "source");
  if (previousSourceCommit !== null) {
    commit(source, previousSourceCommit, "previous source");
    try {
      git(source, "merge-base", "--is-ancestor", previousSourceCommit, sourceCommit);
    } catch {
      throw new Error("Previous source commit must be an ancestor of the current source commit");
    }
  }
  const range = previousSourceCommit ? `${previousSourceCommit}..${sourceCommit}` : sourceCommit;
  const fields = git(source, "log", "--no-merges", "--format=%H%x00%s%x00", range, "--", ...relatedPaths).split("\0");
  const commits = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index].trim(),
      subject = fields[index + 1];
    if (sha) commits.push({ sha, subject });
  }
  const limit = previousSourceCommit ? 100 : 50;
  const visible = commits.slice(0, limit);
  const lines = [`# cdpHelper v${version}`, "", "## 更新内容", ""];
  if (previousSourceCommit) {
    lines.push(
      `按上一版源码到本版源码的提交范围生成，共 ${commits.length} 条相关非合并提交${commits.length > limit ? `，展示最近 ${limit} 条` : ""}。`,
      "",
    );
    lines.push(`[完整源码差异](${sourceURL}/compare/${previousSourceCommit}...${sourceCommit})`, "");
  } else {
    lines.push(
      `首次发布，无上一版源码基线。以下仅列出最近 ${visible.length} 条相关非合并提交，供核对，不代表完整历史。`,
      "",
    );
    lines.push(`[本版源码](${sourceURL}/tree/${sourceCommit})`, "");
  }
  if (previousTag) lines.push(`上一版本：[${previousTag}](${distributionURL}/releases/tag/${previousTag})。`, "");
  const grouped = categories.map(([title]) => ({ title, commits: [] }));
  for (const entry of visible) {
    const type = /^(\w+)(?:\([^)]*\))?!?:/.exec(entry.subject)?.[1]?.toLowerCase();
    const category = categories.findIndex(([, types]) => types.includes(type));
    grouped[category < 0 ? grouped.length - 1 : category].commits.push(entry);
  }
  for (const group of grouped.filter((group) => group.commits.length)) {
    lines.push(`### ${group.title}`, "");
    for (const entry of group.commits)
      lines.push(`- ${markdown(entry.subject)} ([${entry.sha.slice(0, 7)}](${sourceURL}/commit/${entry.sha}))`);
    lines.push("");
  }
  if (!visible.length) lines.push("本次范围内没有相关源码提交。", "");
  lines.push(
    "## 版本与来源",
    "",
    `- 插件与扩展版本：${version}。`,
    `- 源码提交：[${sourceCommit}](${sourceURL}/commit/${sourceCommit})。`,
    `- 分发提交：[${distributionCommit}](${distributionURL}/commit/${distributionCommit})。`,
    `- 插件 artifact.json SHA-256：\`${artifactSha256}\`。`,
    "",
    "## 下载与安装",
    "",
    `1. 从本 Release 下载 [${assetName}](${distributionURL}/releases/download/v${version}/${assetName})，可用 SHA256SUMS 校验附件。`,
    "2. 解压到稳定目录，在目标浏览器 profile 中手动加载含 manifest.json 的 extension/ 子目录，不要加载 ZIP 根目录。",
    "3. 插件从 cdpHelper 市场单独安装，与扩展使用相同版本；安装插件不会安装浏览器扩展。运行时依赖随包离线展开，用户无需 npm/pnpm install 或下载 Chromium。",
    "4. 扩展更新后手动重载，再通过 browser_status 列出实例并选择目标。",
    "",
    "## 更新 cdpHelper plugin",
    "",
    "Codex（在终端执行）：",
    "",
    "```sh",
    "codex plugin marketplace upgrade cdphelper-plugins",
    "codex plugin add cdphelper@cdphelper-plugins",
    "```",
    "",
    "Claude Code（在终端执行）：",
    "",
    "```sh",
    "claude plugin marketplace update cdphelper-plugins",
    "claude plugin update cdphelper@cdphelper-plugins",
    "```",
    "",
    "更新后退出并重新打开对应宿主，加载新的 cdpHelper plugin；仅重连 MCP 可能继续使用旧启动路径。两端都安装时分别更新，无需重启雪诺。后台交接可能中断旧页面控制和诊断采集，已发出的操作可能继续产生效果，不自动重放操作。",
    "",
    "## 更新 cdpHelper 浏览器扩展",
    "",
    `下载本 Release 的 ${assetName}，解压后将 extension/ 的完整内容替换到原加载目录，保持原路径，不卸载扩展。在每个目标雪诺 profile 的 chrome://extensions 手动重载 cdpHelper 浏览器扩展，确认版本为 ${version}。保留选项页原有服务地址和实例名称，通过 browser_status 核对版本并重新选择实例和页面。`,
    "",
    "更新 plugin 不会自动更新浏览器扩展，更新扩展也不会更新宿主中的 plugin，两者必须使用相同版本。旧后台若报告 upgrade_blocked，请按状态提示处理仍关联旧后台生命周期的隔离窗口后再继续，不强制结束后台绕过保护。",
    "",
    "## 已知限制",
    "",
    "真实雪诺隔离启动尚未通过验收；自动化检查不能替代真实浏览器验收。",
    "",
  );
  return lines.join("\n");
}
