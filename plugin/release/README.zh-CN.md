# cdpHelper 浏览器扩展

此压缩包仅包含浏览器扩展。AI 插件请从 [cdpHelper 插件市场](https://github.com/itMrBoy/cdpHelper)单独安装。插件需要 Node >=22；用户无需执行 npm install，也不下载 Chromium。

1. 从 [cdpHelper 对应 Release](https://github.com/itMrBoy/cdpHelper/releases) 下载扩展 ZIP，解压到稳定目录。插件与扩展保持相同版本。
2. 打开希望 AI 操作的雪诺窗口/profile。在该窗口访问 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中本压缩包内包含 `manifest.json` 的 **extension/** 目录。如果雪诺已随 profile 下发本扩展，启用已有副本即可。
3. 将 cdpHelper 扩展固定到工具栏。扩展向运行中的插件服务登记成功后，图标显示数字徽标，与 AI 列出的实例编号对应；无需先选择或操作浏览器。未固定图标时，可在扩展选项页核对名称、编号和连接状态。多个 profile 可以连接同一个本机服务，同名实例通过编号区分。
4. 如需隔离实例，在 AI 会话中选择启动隔离实例，在新窗口中安装或启用扩展，并在连接成功前保留初始化标签页。等待接入期间不会自动选择其他已有浏览器。

默认本机服务地址为 `ws://127.0.0.1:29393/bridge`。可在扩展选项页保存自定义本机服务地址及实例名称；配置保存在各浏览器 profile 内。不要为不同实例修改此解压目录中的文件。显示编号只代表当前连接：同一后台运行期间不复用，重连换号，后台重启后重新计数；同一 profile 的多个窗口共用编号，断线清空徽标。未命名时显示“浏览器 1”，默认名称不带浏览器品牌。不为识别实例额外读取页面标题或网址。

## 更新 cdpHelper plugin

cdpHelper plugin 安装在 Codex、Claude Code 中，包含本机后台服务；cdpHelper 浏览器扩展安装在雪诺 profile 中。两者分别更新，并保持相同版本。

Codex（在终端执行）：

```sh
codex plugin marketplace upgrade cdphelper-plugins
codex plugin add cdphelper@cdphelper-plugins
```

Claude Code（在终端执行）：

```sh
claude plugin marketplace update cdphelper-plugins
claude plugin update cdphelper@cdphelper-plugins
```

命令完成后，退出并重新打开对应的 Codex 或 Claude Code，以加载新的 cdpHelper plugin；仅重连 MCP 可能继续使用旧启动路径。两端都安装了 plugin 时，分别执行各自的更新命令。无需重启雪诺。后台交接可能中断旧页面控制和诊断采集，已发出的操作可能继续产生效果；恢复后重新选择实例和页面，不自动重放操作。

## 更新 cdpHelper 浏览器扩展

1. 下载与 cdpHelper plugin 相同版本的 Release 扩展 ZIP，先解压到临时目录。
2. 用新包中 `extension/` 的完整内容替换原加载目录的扩展文件，保持原加载路径，不卸载扩展。
3. 在每个目标雪诺 profile 打开 `chrome://extensions`，找到 cdpHelper 浏览器扩展并点击“重新加载”。确认显示的版本与本次 Release 一致。
4. 在扩展选项页核对连接状态，保留原有本机服务地址和实例名称。再让 Agent 调用 `browser_status`，核对 plugin 后台与浏览器扩展版本，并按新的编号重新选择实例和页面。

更新 plugin 不会更新浏览器扩展，更新扩展也不会更新宿主中的 plugin。插件不会下载、缓存、复制或安装本扩展。网页操作使用 Playwright；Computer Use 仅可用于启动雪诺。关闭和清理 AI 创建的隔离 profile 前会征求用户确认。

如果旧 plugin 后台提示 `upgrade_blocked`，它可能仍关联旧版启动、未脱离后台进程生命周期的隔离雪诺窗口。按状态提示处理后再继续；不要通过强制结束后台绕过保护。profile 不自动删除，普通用户自行启动的雪诺窗口无需关闭。

`extension/cdphelper-bridge.json` 记录插件/扩展版本、桥接协议和源码提交。Release 同时提供 `release-manifest.json` 和 `SHA256SUMS` 供完整性校验。标记 `source_dirty: true` 的构建仅用于本地开发，不能作为锁定源码的发布候选。
