import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { defaultModCDPExtensionPath } from "../src/injector/NodeExtensionFiles.js";

test("default extension ZIP resolves to a native absolute filesystem path", () => {
  const expected = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/extension.zip");
  const actual = defaultModCDPExtensionPath();
  assert.equal(actual, expected);
  assert.equal(path.isAbsolute(actual), true);
  if (process.platform === "win32") {
    assert.equal(path.parse(actual).root, path.parse(expected).root);
    assert.doesNotMatch(actual, /^\/[a-z]:/i);
  }
  assert.equal(existsSync(actual), true, "the default path must address the built extension ZIP");
});
