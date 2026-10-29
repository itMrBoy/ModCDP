# cdpHelper 浏览器扩展

此压缩包仅包含浏览器扩展。AI 插件请从 [cdpHelper 插件市场](https://github.com/itMrBoy/cdpHelper)单独安装。插件需要 Node >=22；用户无需执行 npm install，也不下载 Chromium。

1. 从 [cdpHelper 对应 Release](https://github.com/itMrBoy/cdpHelper/releases) 下载扩展 ZIP，解压到稳定目录。插件与扩展保持相同版本。
2. 打开希望 AI 操作的雪诺窗口/profile。在该窗口访问 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中本压缩包内包含 `manifest.json` 的 **extension/** 目录。如果雪诺已随 profile 下发本扩展，启用已有副本即可。
3. 将 cdpHelper 扩展固定到工具栏。扩展向运行中的插件服务登记成功后，图标显示数字徽标，与 AI 列出的实例编号对应；无需先选择或操作浏览器。未固定图标时，可在扩展选项页核对名称、编号和连接状态。多个 profile 可以连接同一个本机服务，同名实例通过编号区分。
4. 如需隔离实例，在 AI 会话中选择启动隔离实例，在新窗口中安装或启用扩展，并在连接成功前保留初始化标签页。等待接入期间不会自动选择其他已有浏览器。

默认本机服务地址为 `ws://127.0.0.1:29393/bridge`。可在扩展选项页保存自定义本机服务地址及实例名称；配置保存在各浏览器 profile 内。不要为不同实例修改此解压目录中的文件。显示编号只代表当前连接：同一后台运行期间不复用，重连换号，后台重启后重新计数；同一 profile 的多个窗口共用编号，断线清空徽标。未命名时显示“浏览器 1”，默认名称不带浏览器品牌。不为识别实例额外读取页面标题或网址。

升级时下载并解压对应版本，在每个目标 profile 中更新或重新加载扩展，再通过新的数字徽标与 AI 列表对应。插件不会下载、缓存、复制或安装本扩展。网页操作使用 Playwright；Computer Use 仅可用于启动雪诺。已有浏览器窗口会保留，关闭和清理 AI 创建的隔离 profile 前会征求用户确认。

`extension/cdphelper-bridge.json` 记录插件/扩展版本、桥接协议和源码提交。Release 同时提供 `release-manifest.json` 和 `SHA256SUMS` 供完整性校验。标记 `source_dirty: true` 的构建仅用于本地开发，不能作为锁定源码的发布候选。
