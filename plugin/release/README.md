# cdpHelper extension

This archive is the browser extension only. Install the AI plugin separately from the [cdpHelper marketplace](https://github.com/itMrBoy/cdpHelper). Node >=22 is required for the plugin; users do not run npm install or download Chromium.

1. Download the extension archive from the [matching cdpHelper Release](https://github.com/itMrBoy/cdpHelper/releases) and extract it to a stable directory. Keep the plugin and extension on the same version.
2. Start the Snow Browser window/profile you want the AI to operate. In that window, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and select this archive's **extension/** directory containing `manifest.json`. If Snow already supplies this extension with the profile, enable that copy instead.
3. Open the extension's options page. Once the plugin service is running, the page displays the instance name, short ID, and connection state. Match that ID with the instance list shown by the AI, then select the target instance. Multiple profiles can connect to the same local service.
4. To start an isolated instance, choose that option in the AI session. Install/enable the extension in the newly opened window and keep its initialization tab until connection succeeds. If startup is pending, no existing browser is selected automatically.

The default local service is `ws://127.0.0.1:29393/bridge`. A custom local service address and optional instance name can be saved in the extension's options page; settings belong to the browser profile. Do not edit files in this unpacked directory for individual instances. The short ID identifies the current connection and changes after reconnection.

When upgrading, download and extract the matching new archive, update/reload the unpacked extension in every target profile, then check its new short ID. The plugin never downloads, caches, copies, or installs this extension. Browser actions use Playwright; Computer Use may only launch Snow Browser. Existing browser windows are preserved. Before closing or cleaning up an AI-created isolated profile, the AI asks for your confirmation.

`extension/cdphelper-bridge.json` records the extension/plugin version, bridge protocol, and source commit. The Release also provides `release-manifest.json` and `SHA256SUMS` for integrity checks. A build marked `source_dirty: true` is a local development build, not a fixed-source release candidate.
