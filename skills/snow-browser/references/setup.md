# 安装技能与连接雪诺浏览器

## 两端安装

`skills/snow-browser/` 是完整技能目录，可以复制到其他机器。根目录 `skills/` 本身不是两端普通本地技能的自动发现目录；将整个 `snow-browser` 文件夹复制到下列位置之一：

| 使用范围 | Codex | Claude Code |
| --- | --- | --- |
| 当前项目 | `<项目>/.agents/skills/snow-browser/` | `<项目>/.claude/skills/snow-browser/` |
| 当前用户的所有项目 | `~/.agents/skills/snow-browser/` | `~/.claude/skills/snow-browser/` |

安装后打开新会话，确认技能列表里存在 `snow-browser`。Codex 的 `agents/openai.yaml` 启用隐式调用；Claude Code 使用标准 `name`、`description` 元数据自动选择，未设置禁用自动调用的字段。两端共用同一份 `SKILL.md`，不依赖 Claude 专属变量、工具白名单或 Codex 专属执行工具。

例如说“使用雪诺浏览器，读取我打开的页面标题”，应匹配本技能。也可以显式调用 Codex 的 `$snow-browser` 或 Claude Code 的 `/snow-browser`。自动选择由客户端根据 description 决定，不能把尚未安装的技能当成已生效。

官方说明：[Codex 本地技能](https://learn.chatgpt.com/docs/build-skills)、[Claude Code 技能](https://code.claude.com/docs/en/skills)。

## 定位运行环境

技能目录与 ModCDP 仓库可以分开。runner 从显式 `--repo`、已有 `MODCDP_ROOT`、当前工作目录的祖先、技能脚本的祖先定位仓库；显式路径错误时立即报错。全局安装后，通常需要传入 `--repo`。

仓库须包含根 `package.json`（`name: modcdp`）、`proxy-existing` 脚本，以及源代码或构建后的代理入口。Node 需 ≥ 22。Playwright 从该仓库的依赖解析，不依赖技能自身或临时任务目录中的 `node_modules`，版本须 ≥ 1.60。

缺少依赖时，使用仓库要求的 pnpm 版本，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
```

仓库 `prepare` 会自动构建。连接已有浏览器不需要运行 `playwright install` 或下载新的浏览器。不要仅安装 production 依赖，因为 Playwright 是开发依赖。

## 复用或启动代理

先核对监听、PID、进程命令行与工作目录，复用已有正确代理。Windows 可按需查询：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9223,29292 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
# 将实际监听 PID 代入：
Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" |
  Select-Object ProcessId,ExecutablePath,CommandLine
```

没有正确代理时，在仓库根目录以当前环境支持的持久终端/后台任务方式运行：

```sh
pnpm run proxy-existing
```

该命令先普通构建，再开启 ReverseWS 重建扩展，最后直接执行 CLI，默认监听客户端 `http://127.0.0.1:9223`、扩展 `ws://127.0.0.1:29292`。Windows 若用 `Start-Process` 管理后台任务，使用隐藏窗口并保留 PID、日志路径；仅清理为本任务启动的进程，不按端口批量终止其他进程。

构建会更新仓库中被 Git 跟踪的 `python/modcdp/extension.zip` 和 `go/modcdp/injector/extension.zip`。已有这些文件的未提交改动时，先确认其用途，优先复用正确构建；需要新构建而又无法保全本地改动时先说明阻碍。不要为启动代理顺手提交或丢弃用户文件。

不要使用 `proxy-local`：它启动独立浏览器。也不要用普通 `pnpm run proxy`：它会重建默认扩展并关闭 ReverseWS。

## 扩展接入

雪诺浏览器尚未启动时，允许使用环境已有的 Computer Use（computerUse / 桌面自动化）启动它；若已运行则复用。Computer Use 的用途仅限启动，后续网页操作与网页截图统一通过 ModCDP + Playwright 完成，连接失败也不改用 Computer Use 操作网页。

1. 确认用户要操作的雪诺浏览器已经打开。需要安装/重载扩展而当前允许的工具无法完成时，请用户按以下步骤操作；不要改用 Computer Use 操作扩展管理页。在支持的扩展管理页（通常为 `chrome://extensions`）开启开发者模式。
2. 加载已解压扩展，选择当前 checkout 的 **`dist/extension` 绝对路径**，不要选源码 `extension/`。
3. 已加载时确认扩展详情中的源目录并重载；另一 worktree 的已加载扩展不会被本次构建更新。
4. 在雪诺浏览器中打开目标普通 HTTP/HTTPS 网页。内部页、被策略限制的页面不保证可调试。浏览器/管理员必须允许扩展安装及 `chrome.debugger`；本方案不绕过权限限制。
5. 顺序执行 runner 的页面发现与任务。HTTP discovery 成功但连接超时，通常还需检查扩展 peer、构建开关、权限或其他 CDP 客户端。

扩展安装和重载只能在实际雪诺浏览器上完成。无法从当前工具操作扩展管理页时，请用户完成上述具体步骤后继续，不用别的浏览器代替。

## 任务文件约定

```sh
node "<技能目录>/scripts/run.mjs" --repo "<仓库目录>" --endpoint "http://127.0.0.1:9223" --task "<任务.mjs>"
```

`--task` 文件默认导出 async 函数，接收 `{ browser, context }`，可返回能 JSON 序列化的简短结果。省略 `--task` 只列出默认 context 的普通页面；单页标题读取超过 5 秒会记录错误并继续列举。runner 不启动代理、不安装扩展、不新建页面，并在任务成功或失败时断开客户端。支持 timeout 的 Playwright 操作默认等待 10 秒，导航默认 15 秒；按任务需要给具体操作设置合理 timeout，不使用无限等待。

需要依赖额外 CDP 能力时，以实际命令结果为准。详情以 checkout 的 `README.zh-CN.md` 和 `js/scripts/verify-existing-playwright.mjs` 为准，后者包含截图、性能与 Trace 验收，会触发采集，普通浏览任务无需整套执行。
