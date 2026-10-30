# cdpHelper extension

This archive is the browser extension only. Install the AI plugin separately from the [cdpHelper marketplace](https://github.com/itMrBoy/cdpHelper). Node >=22 is required for the plugin; users do not run npm install or download Chromium.

1. Download the extension archive from the [matching cdpHelper Release](https://github.com/itMrBoy/cdpHelper/releases) and extract it to a stable directory. Keep the plugin and extension on the same version.
2. Start the Snow Browser window/profile you want the AI to operate. In that window, open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and select this archive's **extension/** directory containing `manifest.json`. If Snow already supplies this extension with the profile, enable that copy instead.
3. Pin cdpHelper to the browser toolbar. Once the extension registers with the running plugin service, its number badge matches the instance number shown by the AI, before selection or browser operations. The extension's options page also shows the name, number, and connection state if the icon is not pinned. Multiple profiles can connect to the same local service; duplicate names are distinguished by their numbers.
4. To start an isolated instance, choose that option in the AI session. Install/enable the extension in the newly opened window and keep its initialization tab until connection succeeds. If startup is pending, no existing browser is selected automatically.

The default local service is `ws://127.0.0.1:29393/bridge`. A custom local service address and optional instance name can be saved in the extension's options page; settings belong to the browser profile. Do not edit files in this unpacked directory for individual instances. The display number identifies the current connection: disconnected numbers are not reused while the service runs, reconnecting gets a new number, and restarting the service resets numbering. Windows in the same profile share a number. The badge clears on disconnect. Unnamed instances are displayed as “浏览器 1”, without a browser brand. No page titles or URLs are collected for identification.

## Update the cdpHelper plugin

The cdpHelper plugin is installed in Codex or Claude Code and includes the local background service. The cdpHelper browser extension is installed in a Snow Browser profile. Update them separately and keep their versions identical.

Codex (run in a terminal):

```sh
codex plugin marketplace upgrade cdphelper-plugins
codex plugin add cdphelper@cdphelper-plugins
```

Claude Code (run in a terminal):

```sh
claude plugin marketplace update cdphelper-plugins
claude plugin update cdphelper@cdphelper-plugins
```

After updating, exit and reopen the corresponding Codex or Claude Code host to load the new cdpHelper plugin. Reconnecting MCP alone may reuse the old launch path. If installed in both hosts, update each separately. Snow Browser does not need to restart. Backend handover may interrupt old page control and diagnostics; operations already sent may still take effect. Select the instance and page again afterward; operations are not replayed automatically.

## Update the cdpHelper browser extension

1. Download the Release extension ZIP matching your cdpHelper plugin version and extract it to a temporary directory.
2. Replace the extension files at the original loaded location with the complete contents of the new archive's `extension/` directory. Keep the original path and do not uninstall the extension.
3. In every target Snow Browser profile, open `chrome://extensions` and click **Reload** for the cdpHelper browser extension. Confirm that its version matches this Release.
4. Check the extension options page for connection status, keeping the existing local service address and instance name. Ask the Agent to call `browser_status`, verify the plugin backend and browser extension versions, then select the instance and page again using the new number.

Updating the plugin does not update the browser extension, and updating the extension does not update either host's plugin. The plugin never downloads, caches, copies, or installs this extension. Browser actions use Playwright; Computer Use may only launch Snow Browser. Before closing or cleaning up an AI-created isolated profile, the AI asks for your confirmation.

If the old plugin backend reports `upgrade_blocked`, it may own a legacy isolated Snow Browser window whose lifetime is still tied to that backend. Follow the status guidance before continuing; do not bypass the protection by forcefully terminating the backend. Profiles are not deleted automatically, and ordinary user-started Snow Browser windows do not need to close.

`extension/cdphelper-bridge.json` records the extension/plugin version, bridge protocol, and source commit. The Release also provides `release-manifest.json` and `SHA256SUMS` for integrity checks. A build marked `source_dirty: true` is a local development build, not a fixed-source release candidate.
