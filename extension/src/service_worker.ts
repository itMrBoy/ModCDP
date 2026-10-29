// MODCDP_TS_ONLY: DO NOT TRANSLATE THIS FILE TO OTHER LANGUAGES.
// Reason: only runs in browser.
// Extension service worker entry point.

import { ModCDPServer } from "../../js/src/server/ModCDPServer.js";
import type { ReverseWSBridgeOptions } from "../../js/src/transport/ReverseWSDownstreamTransport.js";

declare const __MODCDP_ENABLE_REVERSEWS__: boolean;
declare const __MODCDP_ENABLE_NATS__: boolean;
declare const __CDPHELPER_PLUGIN_BRIDGE__: boolean;

const snowPlugin = typeof __CDPHELPER_PLUGIN_BRIDGE__ !== "undefined" && __CDPHELPER_PLUGIN_BRIDGE__;
const defaultSnowBridgeUrl = "ws://127.0.0.1:29393/bridge";

function snowBridgeUrl(value: unknown) {
  const endpoint = typeof value === "string" && value ? value : defaultSnowBridgeUrl;
  const url = new URL(endpoint);
  if (
    !/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/.test(endpoint) ||
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/bridge" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("cdpHelper bridge URL must be ws://127.0.0.1:<port>/bridge.");
  }
  return url;
}

async function start() {
  let endpoint: string | undefined;
  let bridge: ReverseWSBridgeOptions | undefined;
  if (snowPlugin) {
    // Settings belong to this profile, never to the shared extension directory.
    const settings = await chrome.storage.local.get(["snowBridgeUrl", "snowInstanceName", "snowOwnedLaunchToken"]);
    await chrome.storage.session.set({ snowBridgeState: { connected: false } });
    const url = snowBridgeUrl(settings.snowBridgeUrl);
    endpoint = url.href;
    const initializeOrigin = `http://${url.host}`;
    let launchToken: string | undefined;
    let helloReady = false;
    let reloadRequested = false;
    const observeInitialization = (tab: chrome.tabs.Tab) => {
      if (launchToken || reloadRequested) return;
      // A pre-installed worker can start before the startup tab's URL commits.
      // Observe before querying so a URL published during the query is not lost.
      for (const candidate of [tab.pendingUrl, tab.url]) {
        if (!candidate) continue;
        try {
          const tabUrl = new URL(candidate);
          const match = /^\/initialize\/([a-f0-9]{64})$/.exec(tabUrl.pathname);
          if (tabUrl.origin !== initializeOrigin || tabUrl.search || tabUrl.hash || !match) continue;
          if (helloReady) {
            // The existing connection may be an ordinary, unselected instance.
            // Reload once to reconnect with the nonce; never mutate its identity.
            reloadRequested = true;
            chrome.runtime.reload();
          } else {
            launchToken = match[1];
          }
          return;
        } catch {
          // Browser internal pages do not necessarily have an ordinary URL.
        }
      }
    };
    chrome.tabs.onCreated.addListener(observeInitialization);
    chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
      observeInitialization(change.url ? { ...tab, url: change.url } : tab);
    });
    for (const tab of await chrome.tabs.query({})) observeInitialization(tab);
    if (
      !launchToken &&
      typeof settings.snowOwnedLaunchToken === "string" &&
      /^[a-f0-9]{64}$/.test(settings.snowOwnedLaunchToken)
    ) {
      launchToken = settings.snowOwnedLaunchToken;
    }
    const name = typeof settings.snowInstanceName === "string" ? settings.snowInstanceName.trim().slice(0, 80) : "";
    // Serialize updates so an old registration cannot overwrite a later disconnect.
    let stateWrite = Promise.resolve();
    bridge = {
      hello: {
        version: 2,
        extension_version: chrome.runtime.getManifest().version,
        ...(name ? { name } : {}),
        ...(launchToken ? { launch_token: launchToken } : {}),
      },
      onRegistration(registration) {
        stateWrite = stateWrite
          .catch(() => {})
          .then(async () => {
            await chrome.storage.session.set({
              snowBridgeState: registration ? { connected: true, ...registration } : { connected: false },
            });
            if (registration?.owned && launchToken) {
              await chrome.storage.local.set({ snowOwnedLaunchToken: launchToken });
            }
          });
        return stateWrite;
      },
    };
    helloReady = true;
  } else {
    // Retain standalone SDK compatibility; plugin builds never read this file.
    const bridgeConfig: { reversews_endpoint?: string } = await fetch(chrome.runtime.getURL("bridge-config.json"))
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}));
    endpoint = bridgeConfig.reversews_endpoint;
    if (endpoint && !/^ws:\/\/127\.0\.0\.1:\d+\/?(?:\?|$)/.test(endpoint)) {
      throw new Error("The plugin bridge endpoint must be a loopback WebSocket URL.");
    }
  }
  const server = new ModCDPServer(
    {},
    {
      enable_reversews: typeof __MODCDP_ENABLE_REVERSEWS__ !== "undefined" && __MODCDP_ENABLE_REVERSEWS__,
      enable_nats: typeof __MODCDP_ENABLE_NATS__ !== "undefined" && __MODCDP_ENABLE_NATS__,
      reversews_endpoint: endpoint,
      reversews_bridge: bridge,
    },
  );
  await server.start();
}
// Extension service workers do not support module top-level await.
void start().catch(async (error) => {
  console.error("ModCDP startup failed:", error);
  if (snowPlugin) await chrome.storage.session.set({ snowBridgeState: { connected: false, error: String(error) } });
});
