// Real extension builds for browser integration tests; no transport substitution.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ModCDPServerStartupOptions } from "../src/server/ModCDPServer.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function buildExtensionFixture(options: ModCDPServerStartupOptions & { reversews_url?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "modcdp-extension-fixture-"));
  const extension_path = path.join(dir, "extension");
  const close = () => rm(dir, { recursive: true, force: true });
  try {
    await cp(path.join(root, "dist/extension"), extension_path, { recursive: true });
    await build({
      entryPoints: [path.join(root, "extension/src/service_worker.ts")],
      outfile: path.join(extension_path, "modcdp/service_worker.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: ["chrome116"],
      define: {
        __MODCDP_ENABLE_REVERSEWS__: String(options.enable_reversews ?? false),
        __MODCDP_ENABLE_NATS__: String(options.enable_nats ?? false),
        ...(options.reversews_url ? { __MODCDP_REVERSEWS_URL__: JSON.stringify(options.reversews_url) } : {}),
      },
      logLevel: "silent",
    });
    return { extension_path, close };
  } catch (error) {
    await close();
    throw error;
  }
}
