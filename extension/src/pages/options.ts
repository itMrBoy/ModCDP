// MODCDP_TS_ONLY: DO NOT TRANSLATE THIS FILE TO OTHER LANGUAGES.
// Reason: only runs in browser.

import { instanceLabel } from "../instanceDisplay.js";
type RuntimeJSON = {
  type?: string;
  config?: unknown;
  state?: unknown;
  children?: Record<string, RuntimeJSON>;
};

const out = document.getElementById("out")!;
declare const __CDPHELPER_PLUGIN_BRIDGE__: boolean;
const snowPlugin = typeof __CDPHELPER_PLUGIN_BRIDGE__ !== "undefined" && __CDPHELPER_PLUGIN_BRIDGE__;

function showSnowState(value: unknown) {
  const state = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const status = document.getElementById("cdphelper-status")!;
  status.textContent = state.connected
    ? `Connected / 已连接: ${instanceLabel(state)}`
    : `Disconnected / 未连接${state.error ? `: ${String(state.error)}` : ""}`;
}

if (snowPlugin) {
  document.getElementById("cdphelper-bridge")!.hidden = false;
  const nameInput = document.getElementById("cdphelper-name") as HTMLInputElement;
  const urlInput = document.getElementById("cdphelper-url") as HTMLInputElement;
  const result = document.getElementById("cdphelper-settings-result")!;
  void chrome.storage.local.get(["snowInstanceName", "snowBridgeUrl"]).then((settings) => {
    nameInput.value = typeof settings.snowInstanceName === "string" ? settings.snowInstanceName : "";
    urlInput.value =
      typeof settings.snowBridgeUrl === "string" ? settings.snowBridgeUrl : "ws://127.0.0.1:29393/bridge";
  });
  void chrome.storage.session.get("snowBridgeState").then((settings) => showSnowState(settings.snowBridgeState));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.snowBridgeState) showSnowState(changes.snowBridgeState.newValue);
  });
  document.getElementById("cdphelper-settings")!.onsubmit = (event) => {
    event.preventDefault();
    try {
      const url = new URL(urlInput.value.trim());
      if (
        !/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/.test(urlInput.value.trim()) ||
        url.protocol !== "ws:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/bridge" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("Use ws://127.0.0.1:<port>/bridge / 请填写本机服务地址。");
      }
      void chrome.storage.local
        .set({ snowInstanceName: nameInput.value.trim(), snowBridgeUrl: url.href })
        .then(() => chrome.runtime.reload())
        .catch((error) => {
          result.textContent = String(error);
        });
    } catch (error) {
      result.textContent = String(error);
    }
  };
}

function renderObject(title: string, value: unknown) {
  const details = document.createElement("details");
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.append(summary);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value ?? {}, null, 2);
  details.append(pre);
  return details;
}

function renderNode(node: RuntimeJSON) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = node.type ?? "Unknown";
  section.append(heading);
  section.append(renderObject("config", node.config ?? {}));
  section.append(renderObject("state", node.state ?? {}));
  for (const [name, child] of Object.entries(node.children ?? {})) {
    const child_section = renderNode(child);
    const label = document.createElement("h3");
    label.textContent = name;
    child_section.prepend(label);
    section.append(child_section);
  }
  return section;
}

const load = () =>
  chrome.runtime.sendMessage({ type: "modcdp.options.status" }, (status) => {
    out.replaceChildren(renderNode(status || { type: "Error", state: chrome.runtime.lastError }));
  });
document.getElementById("refresh")!.onclick = load;
load();
setInterval(load, 2000);
