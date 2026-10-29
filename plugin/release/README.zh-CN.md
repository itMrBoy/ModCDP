# cdpHelper 浏览器扩展

此压缩包仅包含浏览器扩展。AI 插件请从 [cdpHelper 插件市场](https://github.com/itMrBoy/cdpHelper)单独安装。插件需要 Node >=22；用户无需执行 npm install，也不下载 Chromium。

1. 从 [cdpHelper 对应 Release](https://github.com/itMrBoy/cdpHelper/releases) 下载扩展 ZIP，解压到稳定目录。插件与扩展保持相同版本。
2. 打开希望 AI 操作的雪诺窗口/profile。在该窗口访问 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中本压缩包内包含 `manifest.json` 的 **extension/** 目录。如果雪诺已随 profile 下发本扩展，启用已有副本即可。
3. 打开扩展选项页。插件服务启动后，页面显示实例名称、短编号和连接状态。将此短编号与 AI 列出的实例对应，再选择目标实例。多个 profile 可以连接同一个本机服务。
4. 如需隔离实例，在 AI 会话中选择启动隔离实例，在新窗口中安装或启用扩展，并在连接成功前保留初始化标签页。等待接入期间不会自动选择其他已有浏览器。

默认本机服务地址为 `ws://127.0.0.1:29393/bridge`。可在扩展选项页保存自定义本机服务地址及实例名称；配置保存在各浏览器 profile 内。不要为不同实例修改此解压目录中的文件。短编号代表当前运行连接，重连后会变化。

升级时下载并解压对应版本，在每个目标 profile 中更新或重新加载扩展，再核对新的短编号。插件不会下载、缓存、复制或安装本扩展。网页操作使用 Playwright；Computer Use 仅可用于启动雪诺。已有浏览器窗口会保留，关闭和清理 AI 创建的隔离 profile 前会征求用户确认。

`extension/cdphelper-bridge.json` 记录插件/扩展版本、桥接协议和源码提交。Release 同时提供 `release-manifest.json` 和 `SHA256SUMS` 供完整性校验。标记 `source_dirty: true` 的构建仅用于本地开发，不能作为锁定源码的发布候选。
