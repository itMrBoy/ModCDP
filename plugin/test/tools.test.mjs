import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTool } from "../src/tools.mjs";

const instance_id = "11111111-1111-4111-8111-111111111111";

test("browser_select retains strict mode-specific validation behind its portable listing schema", () => {
  for (const args of [
    { mode: "reuse", instance_id },
    { mode: "isolated" },
    { mode: "isolated", executable: "C:/Snow/snowview.exe" },
  ]) {
    assert.deepEqual(parseTool("browser_select", args), args);
  }
  for (const args of [
    {},
    { mode: "reuse" },
    { mode: "reuse", instance_id: "invalid" },
    { mode: "unknown" },
    { mode: "reuse", instance_id, executable: "C:/Snow/snowview.exe" },
    { mode: "isolated", instance_id },
    { mode: "isolated", executable: 123 },
    { mode: "isolated", extra: true },
  ]) {
    assert.throws(() => parseTool("browser_select", args), undefined, JSON.stringify(args));
  }
});
