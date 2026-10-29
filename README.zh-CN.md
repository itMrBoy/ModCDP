# ModCDP

[English](README.md) | [简体中文](README.zh-CN.md)

ModCDP 通过浏览器扩展为 CDP 增加自定义命令、事件和中间件，并提供客户端 SDK 与 Node 代理。调用方可以沿用 CDP 消息格式，在扩展的 service worker 中访问 `chrome.*` API，或通过代理连接现有的自动化工具。

对于**禁用了对外 CDP 接口的浏览器**，当前 Node 代理可通过扩展的 ReverseWS 连接和 `chrome.debugger` 暴露本地 CDP 入口。这要求浏览器允许安装扩展，并允许使用 `chrome.debugger`；浏览器或管理员禁用这些能力时，该方式也无法使用。

## 主要功能

| 能力                   | 用途                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Mod.evaluate`         | 在扩展 service worker 中运行表达式，访问 `chrome.*` 和 `cdp` 桥接对象                                          |
| `Mod.addCustomCommand` | 注册 `Custom.*` 命令，将常用操作封装为协议调用                                                                 |
| `Mod.addCustomEvent`   | 注册自定义事件，通过同一连接订阅和接收                                                                         |
| `Mod.addMiddleware`    | 按方法名或通配符拦截请求、响应、事件                                                                           |
| Node 代理              | 向普通 CDP 客户端提供入口，支持常规上游及基于扩展的 ReverseWS 模式                                             |
| 多种传输与路由         | 按场景使用 WebSocket、pipe、ReverseWS、Native Messaging、NATS，以及直接 CDP、扩展回环或 `chrome.debugger` 路由 |

不同传输、浏览器和客户端使用的命令会影响兼容性。扩展模式实现了部分浏览器级 CDP 行为，并不等同于浏览器原生 CDP 的全部能力。

## 目录职责

项目保留 JavaScript SDK、Node 代理、浏览器扩展，以及 Codex / Claude Code 共用的雪诺插件运行时。

| 目录                   | 作用                                                                     | 何时使用                             |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `js/`                  | TypeScript/JavaScript 客户端，以及 Node 代理、浏览器端服务实现和开发工具 | 启动当前代理、使用 JS SDK 或构建扩展 |
| `extension/`           | 浏览器扩展入口与静态页面，服务逻辑复用 `js/` 中的实现                    | 加载到受控浏览器中                   |
| `plugin/`              | 共用本机 MCP 运行时与启动器                                              | 通过 Codex 或 Claude Code 操作雪诺   |
| `skills/cdphelper/` | 两端共用技能源码                                                         | 模式选择、网页操作及退出清理指引     |
| `dist/`                | 构建后的 JS、可加载扩展及 ZIP 产物                                       | 运行 Node CLI、安装构建后的扩展      |

扩展统一输出到 `dist/`，独立 Node 代理与插件入口均可使用。

源码入口：

- [客户端与代理](js/src/)：客户端、代理 CLI、启动器、注入器、传输和路由。
- [扩展入口](extension/src/service_worker.ts) 与 [静态页面](extension/src/pages/)：加载共享浏览器端服务。
- [JS 示例](js/examples/)：SDK 调用示例。
- [英文技术说明](README.md)：完整 JS SDK 示例、架构、协议流转图和历史兼容性记录。

## 依赖与安装

以下是源码开发、Node 代理和扩展构建的依赖；插件用户只需 Node ≥22 和已安装的雪诺浏览器，无需安装 pnpm 或执行 npm install。

- **Node ≥ 22**。
- **pnpm 10.33.2**，与 `package.json` 的 `packageManager` 一致。
- 支持所需 MV3 扩展 API 的浏览器。扩展清单最低引擎版本为 116；子 iframe 的 flattened 调试会话需要引擎版本 ≥ 125。
- Windows 构建使用 PowerShell 打包；其他平台需要 PATH 中有 `zip`。

在仓库根目录安装：

```sh
pnpm install --frozen-lockfile
```

安装会执行现有 `prepare`，自动完成包和扩展构建。Paseo 的 worktree 初始化与 `install` 快捷入口都使用该命令；`package.json` 没有额外的 `install` 生命周期脚本。

## 构建及产物

```sh
pnpm run build
pnpm run build:package
pnpm run build:extension-assets
pnpm run build:plugin
```

`build` 依次编译 TypeScript、构建扩展资源。`build:package` 只编译 JS 包；`build:extension-assets` 只重新打包扩展。`build:plugin` 生成包含两端清单、运行时和生产依赖的完整 `dist/plugin-marketplace/`。

主要产物是 `dist/js/`、可直接加载的 `dist/extension/` 和 `dist/extension.zip`。扩展不会再同步到其他 SDK 目录。

普通安装和构建默认关闭 ReverseWS、NATS。仅启用 ReverseWS：

```sh
pnpm run build
pnpm run build:extension-assets -- --enable-reversews
```

NATS 可通过 `--enable-nats` 开启，也可与 `--enable-reversews` 同时传入；NATS 需要另行启动提供 `ws://127.0.0.1:4223` 的服务。Native Messaging 还需要浏览器配置原生宿主，不是独立的 shell 启动方式。

构建不会重载已安装的扩展，也不会监听源码。普通 `build` 会再次关闭 ReverseWS；若正在使用已有浏览器模式，应重新运行对应启动入口并重载扩展。

## Codex / Claude Code 雪诺浏览器插件

唯一插件市场入口为 [itMrBoy/cdpHelper](https://github.com/itMrBoy/cdpHelper) 的 main 分支。本 ModCDP 仓库维护源码、构建和测试，并通过根目录 `cdpHelper/` Git 子模块引入分发仓库；关联只有这一方向，cdpHelper 不再引入 ModCDP 或保存源码子模块。分发仓库根目录放 `.agents/plugins/marketplace.json` 和 `.claude-plugin/marketplace.json`，`plugins/cdphelper/` 放编译后的插件和生产依赖。ModCDP 根目录不能作为插件市场。分发仓库和 Release 尚待发布及完整验收，当前不能宣称用户已可从远端安装。

维护者可在当前检出的 `cdpHelper/` 下查看固定版本的市场和产物。远端具备所锁定提交后，新检出可执行 `git submodule update --init -- cdpHelper`；插件用户直接使用 cdpHelper，无需克隆源码仓库。维护顺序为：先提交干净源码并构建，再将已核验产物提交到 cdpHelper，最后更新 ModCDP 的子模块指针。产物元数据记录实际构建源码提交，它可以早于父仓后续的指针提交，不为使两者 SHA 相等而循环重建。

用户只需 Node ≥22 和已安装的雪诺，无需 npm/pnpm install、本地构建或下载 Chromium。扩展由用户自行下载独立 Release ZIP，解压后在每个目标 profile 手动加载其中含 `manifest.json` 的 `extension/` 子目录（不是 ZIP 根目录）；计划附件为 tag `v0.1.1` 下的 `cdphelper-extension-v0.1.1.zip`，目前尚未发布。插件不接收扩展目录、不下载或复制扩展、不改写公共扩展目录；每个 profile 的身份和连接配置存在扩展自己的 storage 中。

每会话首次操作先调用 `browser_status`，展示已有实例的名称、短编号与状态，再在同一个问题中让用户选已有实例或启动新的隔离实例；不先泛问模式。普通 profile 统一通过 `127.0.0.1:29393/bridge` 登记；`browser_status` 返回带短编号的 inventory，用户选定后，技能映射为 UUID，调用 `browser_select({mode:"reuse",instance_id:"<UUID>"})`。隔离模式使用 `browser_select({mode:"isolated"})` 请求独立 profile，以一次性启动 URL 关联扩展。URL 只证明启动意图，不证明真实隔离：雪诺可能退出新进程或将 URL 打开到原有窗口。接入带隔离 nonce 的连接及每次自有实例网页操作前，Broker 都核验实际可执行文件与精确 profile 参数对应的存活进程；失败则 detach，不发送页面操作。目前该核验仅实现于 Windows，其他平台隔离模式保持不可验证并拒绝操作，复用不受影响。真实雪诺隔离验收尚未通过。两种模式都通过 Playwright 操作网页，Computer Use 只可启动雪诺。

不同标签页可以并行，同一标签页由一个会话独占。断线后旧引用失效，重新读取 inventory 并按用户明确选择实例，再发现和绑定页面，不自动 rebind 或重放提交。离开隔离实例前询问是否关闭并清理；未明确同意和异常断开均保留。复用浏览器与标签页始终保留。安装、升级及源码兼容入口见 [连接说明](skills/cdphelper/references/setup.md)。不发布自有 npm 包；技术校验和测试通过不代表已取得上游分发授权。

## 两种启动方式

完整启动参数统一维护在根目录 `package.json`；Paseo 的同名快捷入口只调用对应 pnpm 命令。两种模式共用 `http://127.0.0.1:9223`，应先停止一种再启动另一种。

| 命令                      | 浏览器来源                                     | 端口                                              |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `pnpm run proxy-local`    | 客户端连接时启动独立浏览器，并加载构建后的扩展 | 客户端入口 9223                                   |
| `pnpm run proxy-existing` | 已运行的浏览器通过手动加载的扩展接入           | 客户端入口 9223；ReverseWS 监听 `127.0.0.1:29292` |

### 启动独立浏览器

```sh
pnpm run proxy-local
```

该命令先构建，再以 `launcher-mode=local`、`upstream-mode=ws`、`injector-mode=cli` 启动代理，扩展路径为 `dist/extension`。浏览器在 CDP 客户端连接时启动，使用项目的可执行文件发现逻辑。所选浏览器必须支持 `--load-extension`；自动发现不合适时，可在当前终端设置 `CHROME_PATH` 指向兼容的浏览器可执行文件。

该模式使用独立浏览器，不会更新已经运行的其他浏览器中的扩展。普通构建保持 ReverseWS 和 NATS 关闭。

### 连接已有浏览器

```sh
pnpm run proxy-existing
```

该命令按顺序执行普通构建、启用 ReverseWS 的扩展构建，再直接运行构建后的 Node CLI。参数为 `launcher-mode=none`、`upstream-mode=reversews`、`injector-mode=none`，监听 `127.0.0.1:29292` 和客户端端口 9223，不启动新浏览器。

此模式适用于禁用了对外 CDP 接口的浏览器。扩展主动连接 `ws://127.0.0.1:29292`，再由其 `chrome.debugger` 能力操作普通标签页，无需浏览器开放原生调试端口。

1. 启动上述命令。
2. 在已有浏览器打开扩展管理页（支持时为 `chrome://extensions`），开启开发者模式。
3. 使用“加载已解压的扩展”，选择**当前仓库 / worktree 的 `dist/extension` 绝对路径**。不要选择源码 `extension/`，其中的 service worker 尚未编译。
4. 如果已经加载该路径，点击扩展“重新加载”；在详情页确认源目录确实属于当前 worktree。
5. 打开目标普通网页，再用下方 Playwright 示例连接。

若扩展来自另一个 checkout，当前构建不会更新它；应改为加载当前路径，或将新构建资源复制到原加载目录后重载。扩展可在客户端连接前接入；客户端先到时会等待扩展连接。

两个启动入口都先构建，但不监听文件变化。修改源码后重启对应命令；扩展资源发生变化时还需手动重载。启用 ReverseWS 后直接运行构建好的 CLI 很重要，重新调用通用 `pnpm run proxy` 会先普通构建，覆盖开启状态。

已有浏览器模式每次只支持**一个 CDP 客户端**，客户端依次断开、重连时会保留扩展连接。停止代理不会关闭独立打开的已有浏览器；长期停用代理时，也应禁用扩展，或构建默认资源并重载，避免反复连接已关闭的 ReverseWS 端口。

Paseo 中两种模式使用普通脚本入口，不提供服务健康检查或转发 URL；客户端直接访问本地 9223。

## Playwright 最小连接示例

先运行 `pnpm run proxy-existing` 并加载 / 重载扩展，在已有浏览器打开 `https://example.com`。将以下内容保存为仓库中的 `.mjs` 文件，再用 Node 执行：

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223", {
  noDefaults: true,
});
try {
  const context = browser.contexts()[0];
  const page = context?.pages().find((page) => page.url().startsWith("https://example.com/"));
  if (!page) throw new Error("请先在已有浏览器打开 https://example.com");
  console.log(await page.title());
  console.log(await page.evaluate(() => document.visibilityState));
} finally {
  await browser.close(); // 断开本次 CDP 连接，保留独立打开的已有浏览器
}
```

已有浏览器扩展模式使用 Playwright ≥ 1.60，并传入 `noDefaults: true`，避免默认的浏览器下载设置与页面模拟命令。复用 `browser.contexts()[0]`，不要在该模式下创建隔离浏览器上下文。运行前先断开其他 CDP 自动化客户端。

## 连接验证与兼容性边界

打开 `http://127.0.0.1:9223/json/version` 只能确认代理正在监听，不能证明扩展已连接、目标页可访问或 Playwright 可用。它返回代理的 WebSocket 地址；`/json`、`/json/list` 也只是代理浏览器入口，不是实际页面清单。

可对已打开的普通网页进行验证（末尾是页面 URL 匹配片段，可自行替换）：

```sh
node js/scripts/verify-existing-playwright.mjs http://127.0.0.1:9223 example.com
```

脚本不会导航目标页，会检查页面发现、JS 求值、DOM、截图、指标、CPU Profile 和 Trace，并将报告及产物写入临时目录。报告分别记录 `accessOk` 和各项性能能力；任意检查失败时退出码非零。成功调用 `Mod.evaluate` 也不能替代这组 Playwright 验证。

已在禁用了对外 CDP 接口的浏览器中通过 ModCDP 验证原版 Playwright 1.60 的现有页面发现、求值、DOM、截图、指标、CPU Profile 和 Trace 采集。独立浏览器回归还覆盖跨站 iframe、标签页创建 / 关闭及顺序重连；这些结果不能直接等同于每个已有浏览器都通过了全部验收。其他自动化工具尚需单独验证。

适配器范围是当前普通配置中的普通标签页及子 iframe 会话，不包含内部页面、隐身标签页、隔离浏览器上下文创建或任意原生浏览器操作。不支持的浏览器命令会返回错误。版本号和 UA 来自实际扩展环境；无法取得的 revision、V8 版本字段为空。

## SDK 示例与开发命令

```sh
pnpm run demo:js
pnpm run demo:proxy:playwright
pnpm run demo:proxy:puppeteer
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run format:check
```

示例及完整测试会先构建，可能启动浏览器，且会把扩展恢复为默认开关。

通用 SDK 支持直接连接已有原生 CDP 端点，也支持本地启动、扩展发现和不同传输配置。现有 SDK 配置示例见 [英文 README](README.md#use-the-js-sdk)。示例的 `--loopback` 表示扩展回连原生 CDP；`--debugger` 表示通过扩展 `chrome.debugger` 操作页面；`--direct` 表示普通 CDP 命令直接发往原生端点。这些 SDK 路由选项与上述两个代理快捷入口的选择是不同层面的配置。

## 常见故障

| 现象                                 | 排查方式                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 9223 或 29292 被占用                 | 确认另一启动入口或旧代理已停止；两种模式不能同时占用 9223                                                   |
| 代理已监听，但连接一直等待或没有页面 | 检查扩展 service worker 是否连接 29292，是否加载了当前 worktree 的 ReverseWS 构建，以及目标是否是普通标签页 |
| 扩展反复报连接被拒绝                 | 启动 `proxy-existing`；不再使用时禁用扩展，或普通构建后重载以关闭 ReverseWS。清除旧错误后观察是否出现新错误 |
| 修改后没有生效                       | 启动脚本不会监听；重启脚本构建，核对扩展源目录，再点击重载。之后若运行过普通构建，ReverseWS 会再次关闭      |
| 第二个客户端被拒绝                   | 已有浏览器模式仅支持一个 CDP 客户端，先释放上一连接再重试                                                   |
| 初始化时出现不支持的命令             | 确认 Playwright ≥ 1.60 且设置 `noDefaults: true`；确认命令未超出适配器能力                                  |
| 无法附加调试目标                     | 检查扩展安装、`chrome.debugger` 权限及浏览器策略，必要时关闭冲突的调试会话                                  |
| 页面后台截图异常或画面不同           | 切到前台后对比重试。截图受浏览器可见性与渲染行为影响，不能把一次后台异常推断为所有浏览器都不支持后台截图    |
| 本地模式无法加载扩展                 | 选择支持 `--load-extension` 的浏览器构建；`Extensions.loadUnpacked` 只有在浏览器暴露该 CDP 域时才可用       |
