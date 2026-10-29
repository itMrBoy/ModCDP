import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTool, tools } from "../src/tools.mjs";
import { z } from "zod";

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

test("all tools publish portable object schemas; diagnostics validate bounds and reject forged ownership fields", () => {
  assert.equal(tools.length, 26);
  for (const tool of tools) {
    const schema = z.toJSONSchema(tool.listingSchema ?? tool.schema);
    assert.equal(schema.type, "object", tool.name);
    for (const key of ["oneOf", "anyOf", "allOf"]) assert.ok(!(key in schema), tool.name);
  }
  assert.equal(parseTool("browser_bind", { tab_id: instance_id }).resume_after_user_stop, false);
  assert.equal(parseTool("browser_evaluate", { tab_id: instance_id, function: "() => null" }).timeout_ms, 10000);
  for (const [name, args] of [
    ["browser_evaluate", { tab_id: instance_id, function: "() => null", timeout_ms: 30001 }],
    ["browser_diagnostics_start", { tab_id: instance_id, duration_ms: 300001 }],
    ["browser_performance_trace_start", { tab_id: instance_id, duration_ms: 60001 }],
    ["browser_network_requests", { capture_id: instance_id, limit: 201 }],
    ["browser_console_messages", { capture_id: instance_id, session_id: instance_id }],
  ])
    assert.throws(() => parseTool(name, args));
});
