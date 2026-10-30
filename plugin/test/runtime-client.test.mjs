import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeClient } from "../src/runtime-client.mjs";

function fixture(runtime = "0.2.0:old") {
  let observed = runtime ? { meta: { runtime, pid: 100, token: "private-old" }, status: { runtime, pid: 100 } } : null;
  const calls = [];
  const config = { runtime: "0.2.1:new" };
  const operations = {
    inspectDaemon: async () => observed,
    ensureDaemon: async (_config, options) => {
      calls.push(["ensure", options]);
      observed = {
        meta: { runtime: config.runtime, pid: 101, token: "private-new" },
        status: { runtime: config.runtime, pid: 101 },
      };
      return observed.meta;
    },
    rpc: async (meta, operation, args) => {
      calls.push([operation, args, meta.token]);
      if (operation === "open") return { session_id: "session" };
      if (operation === "tool") return { instances: [], selection_required: true };
      return {};
    },
  };
  const client = new RuntimeClient(config, operations);
  return {
    client,
    calls,
    operations,
    setObserved: (value) => {
      observed = value;
    },
  };
}

test("upgrade needs component-specific notice before exact one-time acknowledgement; private identity is not exposed", async () => {
  const f = fixture();
  f.client.setHost("codex-cli");
  const first = await f.client.call("browser_status", {});
  assert.equal(first.instances, null);
  assert.equal(first.runtime.state, "upgrade_required");
  assert.equal(first.runtime.host, "Codex");
  assert.match(first.runtime.message, /cdpHelper plugin.*0\.2\.1.*0\.2\.0/);
  assert.ok(!JSON.stringify(first).includes("private-old"));
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.client.call("browser_status", { acknowledge_upgrade_notice: "forged" })).runtime.upgrade_notice_id,
    first.runtime.upgrade_notice_id,
  );
  await assert.rejects(f.client.call("browser_new_tab", {}), /PLUGIN_RUNTIME_NOT_READY/);
  assert.equal(f.calls.length, 0);
  const upgrading = await f.client.call("browser_status", {
    acknowledge_upgrade_notice: first.runtime.upgrade_notice_id,
  });
  assert.equal(upgrading.runtime.state, "upgrading");
  await f.client.upgradeTask;
  const ready = await f.client.call("browser_status", {});
  assert.equal(ready.runtime.state, "ready");
  assert.deepEqual(f.calls[0], ["ensure", { upgradeFrom: { runtime: "0.2.0:old", pid: 100, token: "private-old" } }]);
  assert.deepEqual(f.calls.find((x) => x[0] === "tool")[1].args, {});
  await f.client.close();
});

test("notice cannot authorize a different daemon generation", async () => {
  const f = fixture();
  const first = await f.client.call("browser_status", {});
  f.setObserved({ meta: { runtime: "0.2.0:old", pid: 102, token: "replacement" }, status: { runtime: "0.2.0:old" } });
  const next = await f.client.call("browser_status", { acknowledge_upgrade_notice: first.runtime.upgrade_notice_id });
  assert.equal(next.runtime.state, "upgrade_required");
  assert.notEqual(next.runtime.upgrade_notice_id, first.runtime.upgrade_notice_id);
  assert.equal(f.calls.length, 0);
});

test("older host plugin must reload; same version different digest is a conflict, never an automatic replacement", async () => {
  for (const [runtime, state] of [
    ["0.3.0:new", "plugin_reload_required"],
    ["0.2.1:other", "failed"],
  ]) {
    const f = fixture(runtime);
    f.client.setHost("claude-code");
    const result = await f.client.call("browser_status", {});
    assert.equal(result.runtime.state, state);
    assert.equal(result.runtime.host, "Claude Code");
    assert.equal(f.calls.length, 0);
  }
});

test("backend startup failure is queryable state, not an empty inventory or a replayed page operation", async () => {
  const f = fixture(null);
  f.operations.ensureDaemon = async () => {
    throw new Error("port occupied");
  };
  const result = await f.client.call("browser_status", {});
  assert.equal(result.runtime.state, "failed");
  assert.equal(result.instances, null);
  assert.match(result.runtime.message, /cdpHelper plugin.*port occupied/);
});

test("unsafe legacy browser lifetime blocks handover without reporting backend failure or dispatching page actions", async () => {
  const f = fixture();
  let attempts = 0;
  f.operations.ensureDaemon = async () => {
    attempts++;
    throw Object.assign(
      new Error(
        "cdpHelper plugin 后台 0.2.0 无法安全切换至 0.2.1：旧隔离雪诺仍依赖旧后台存活；已保留旧后台、窗口和 profile。",
      ),
      {
        code: "PLUGIN_BROWSER_PRESERVATION_BLOCKED",
        backend_runtime: "0.2.0:old",
      },
    );
  };
  const first = await f.client.call("browser_status", {});
  const switching = await f.client.call("browser_status", {
    acknowledge_upgrade_notice: first.runtime.upgrade_notice_id,
  });
  assert.equal(switching.runtime.state, "upgrading");
  await f.client.upgradeTask;
  const blocked = await f.client.call("browser_status", {});
  assert.equal(blocked.runtime.state, "upgrade_blocked");
  assert.equal(blocked.runtime.component, "cdpHelper plugin");
  assert.equal(blocked.runtime.backend_version, "0.2.0");
  assert.equal(blocked.runtime.target_version, "0.2.1");
  assert.equal(blocked.runtime.next_action, "preserve_old_backend_and_isolated_windows");
  assert.equal(blocked.instances, null);
  assert.match(blocked.runtime.message, /0\.2\.0.*0\.2\.1/);
  await assert.rejects(f.client.call("browser_new_tab", {}), /PLUGIN_RUNTIME_NOT_READY/);
  assert.equal(attempts, 1);
  assert.equal(f.calls.length, 0);
  await f.client.close();
});

test("daemon changed after dispatch never retries a possibly completed side effect", async () => {
  const f = fixture(null);
  await f.client.call("browser_status", {});
  let clicks = 0;
  const original = f.operations.rpc;
  f.operations.rpc = async (meta, operation, args) => {
    if (operation === "tool" && args.name === "browser_click") {
      clicks++;
      throw new Error("fetch failed");
    }
    return original(meta, operation, args);
  };
  await assert.rejects(f.client.call("browser_click", { tab_id: "old-tab" }), /fetch failed/);
  assert.equal(clicks, 1);
  assert.equal(f.client.session, null);
  await f.client.close();
});

test("extension version mismatch remains distinct from plugin backend upgrade", async () => {
  const f = fixture(null);
  const original = f.operations.rpc;
  f.operations.rpc = async (meta, operation, args) =>
    operation === "tool"
      ? {
          instances: [],
          extension_issues: [
            {
              reason: "extension_update_required",
              actual_extension_version: "0.2.0",
              required_extension_version: "0.2.1",
            },
          ],
        }
      : original(meta, operation, args);
  const result = await f.client.call("browser_status", {});
  assert.equal(result.runtime.state, "extension_update_required");
  assert.equal(result.runtime.component, "cdpHelper 浏览器扩展");
  await f.client.close();
});

test("extension newer than plugin asks to update plugin, not downgrade extension", async () => {
  const f = fixture(null),
    original = f.operations.rpc;
  f.operations.rpc = async (meta, operation, args) =>
    operation === "tool"
      ? {
          instances: [],
          extension_issues: [
            {
              reason: "extension_update_required",
              required_action: "plugin_update_or_reload",
              actual_extension_version: "0.3.0",
              required_extension_version: "0.2.1",
            },
          ],
        }
      : original(meta, operation, args);
  const result = await f.client.call("browser_status", {});
  assert.equal(result.runtime.state, "plugin_update_required");
  assert.equal(result.runtime.component, "cdpHelper plugin");
  await f.client.close();
});
