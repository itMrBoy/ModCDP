// MODCDP_TS_ONLY: DO NOT TRANSLATE THIS FILE TO OTHER LANGUAGES.
// Reason: only runs in browser.
// Extension service worker entry point.

import { ModCDPServer } from "../../js/src/server/ModCDPServer.js";

declare const __MODCDP_ENABLE_REVERSEWS__: boolean;
declare const __MODCDP_ENABLE_NATS__: boolean;

const server = new ModCDPServer(
  {},
  {
    enable_reversews: typeof __MODCDP_ENABLE_REVERSEWS__ !== "undefined" && __MODCDP_ENABLE_REVERSEWS__,
    enable_nats: typeof __MODCDP_ENABLE_NATS__ !== "undefined" && __MODCDP_ENABLE_NATS__,
  },
);
void server.start();
