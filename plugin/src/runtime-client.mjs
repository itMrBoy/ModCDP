import { randomUUID } from "node:crypto";

const version = (runtime) => String(runtime ?? "").split(":")[0];
const compare = (a, b) => {
  const left = version(a).split(".").map(Number),
    right = version(b).split(".").map(Number);
  if (left.length !== 3 || right.length !== 3 || [...left, ...right].some((n) => !Number.isSafeInteger(n)))
    throw new Error("无法识别 cdpHelper plugin 后台版本，未执行升级。");
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
};

// MCP transport stays alive independently of daemon readiness. This object owns
// one adapter's notice and service session; no page action is replayed on reconnect.
export class RuntimeClient {
  constructor(config, operations) {
    this.config = config;
    this.operations = operations;
    this.meta = null;
    this.session = null;
    this.notice = null;
    this.closed = false;
    this.queue = Promise.resolve();
    this.host = "当前 Agent 宿主";
  }
  setHost(name = "") {
    this.host = /claude/i.test(name) ? "Claude Code" : /codex/i.test(name) ? "Codex" : "当前 Agent 宿主";
  }
  state(state, backend, extra = {}) {
    return {
      state,
      component: "cdpHelper plugin",
      host: this.host,
      host_plugin_version: version(this.config.runtime),
      backend_version: backend ? version(backend) : null,
      target_version: version(this.config.runtime),
      ...extra,
    };
  }
  unavailable(runtime) {
    return { runtime, selected: null, instances: null, retained: null, selection_required: true };
  }
  serialize(work) {
    const pending = this.queue.catch(() => {}).then(work);
    this.queue = pending;
    return pending;
  }
  async forget() {
    const meta = this.meta,
      session = this.session;
    this.meta = null;
    this.session = null;
    if (meta && session) await this.operations.rpc(meta, "drop", { session_id: session }, 1000).catch(() => {});
  }
  async ready(ack) {
    const { config, operations } = this;
    if (this.closed) throw new Error("cdpHelper plugin MCP 会话已结束。");
    if (this.upgradeTask)
      return this.state("upgrading", this.upgradingFrom, {
        message: "cdpHelper plugin 本机后台正在交接；旧控制和采集会中断，浏览器窗口保留。",
        next_action: "poll_browser_status",
        retry_after_ms: 1000,
      });
    if (this.upgradeError) {
      const error = this.upgradeError;
      this.upgradeError = null;
      throw error;
    }
    const observed = await operations.inspectDaemon(config);
    if (this.meta && (!observed || observed.meta.token !== this.meta.token)) await this.forget();
    if (observed && observed.status.runtime !== config.runtime) {
      const order = compare(config.runtime, observed.status.runtime);
      if (order <= 0) {
        this.notice = null;
        const message =
          order < 0
            ? `${this.host} 当前会话加载的 cdpHelper plugin 为 ${version(config.runtime)}，本机 plugin 后台已为 ${version(observed.status.runtime)}。请重新加载 ${this.host} 的 cdpHelper plugin 配置；若不支持重新加载，请退出并重新打开 ${this.host}。仅重连 MCP 可能继续使用旧启动路径，无需重启雪诺。`
            : `cdpHelper plugin ${version(config.runtime)} 与本机同版本后台的产物摘要不同。请重新安装完整的同版本 cdpHelper plugin；未替换后台。`;
        return this.state(order < 0 ? "plugin_reload_required" : "failed", observed.status.runtime, { message });
      }
      if (
        !this.notice ||
        this.notice.snapshot.token !== observed.meta.token ||
        this.notice.snapshot.runtime !== observed.status.runtime
      ) {
        this.notice = {
          id: randomUUID(),
          snapshot: { runtime: observed.status.runtime, pid: observed.meta.pid, token: observed.meta.token },
        };
      }
      const message = `已安装的 cdpHelper plugin 为 ${version(config.runtime)}，本机 plugin 后台仍为 ${version(observed.status.runtime)}。将中断旧版 plugin 的页面控制和诊断采集，切换至 ${version(config.runtime)} 后台。雪诺窗口、标签页和 profile 保留。已发出的操作可能继续产生效果，不能自动重放。`;
      if (ack !== this.notice.id)
        return this.state("upgrade_required", observed.status.runtime, {
          message,
          upgrade_notice_id: this.notice.id,
          next_action: "inform_user_then_acknowledge_upgrade_notice",
        });
      const snapshot = this.notice.snapshot;
      await this.forget();
      this.notice = null;
      this.upgradingFrom = snapshot.runtime;
      this.upgradeTask = Promise.resolve()
        .then(async () => {
          const meta = await operations.ensureDaemon(config, { upgradeFrom: snapshot });
          if (!this.closed) this.meta = meta;
          this.lastUpgrade = {
            message,
            previous_backend_version: version(snapshot.runtime),
            interruption:
              "旧 cdpHelper plugin 会话和页面引用已失效；未完成采集可能中断，请重新选择实例，不要重放未知结果的操作。",
          };
        })
        .catch((error) => {
          this.upgradeError = error;
        })
        .finally(() => {
          this.upgradeTask = null;
        });
      return this.state("upgrading", snapshot.runtime, {
        message,
        next_action: "poll_browser_status",
        retry_after_ms: 1000,
      });
    } else if (!this.meta) {
      this.meta = await operations.ensureDaemon(config);
      this.notice = null;
    }
    if (!this.session) {
      const opened = await operations.rpc(this.meta, "open");
      if (this.closed) {
        await operations.rpc(this.meta, "drop", { session_id: opened.session_id }).catch(() => {});
        throw new Error("cdpHelper plugin MCP 会话已结束。");
      }
      this.session = opened.session_id;
    }
    return this.state("ready", this.meta.runtime, this.lastUpgrade ? { upgrade_notice: this.lastUpgrade } : {});
  }
  async call(name, args) {
    return this.serialize(async () => {
      let runtime;
      try {
        runtime = await this.ready(name === "browser_status" ? args.acknowledge_upgrade_notice : undefined);
      } catch (error) {
        if (name !== "browser_status") throw error;
        const reload = error.code === "PLUGIN_RELOAD_REQUIRED";
        const preservationBlocked = error.code === "PLUGIN_BROWSER_PRESERVATION_BLOCKED";
        return this.unavailable(
          this.state(
            preservationBlocked ? "upgrade_blocked" : reload ? "plugin_reload_required" : "failed",
            error.backend_runtime ?? null,
            {
              message: reload
                ? `${this.host} 当前会话加载旧版 cdpHelper plugin ${version(this.config.runtime)}。请重新加载 ${this.host} 的 cdpHelper plugin 配置；不支持时退出并重新打开该宿主。仅重连 MCP 可能仍沿用旧路径，无需重启雪诺。`
                : preservationBlocked
                  ? error.message
                  : `cdpHelper plugin 本机服务未就绪：${error.message}`,
              ...(preservationBlocked
                ? { error_code: error.code, next_action: "preserve_old_backend_and_isolated_windows" }
                : {}),
            },
          ),
        );
      }
      if (runtime.state !== "ready") {
        if (name === "browser_status") return this.unavailable(runtime);
        throw new Error(
          JSON.stringify({ code: "PLUGIN_RUNTIME_NOT_READY", ...runtime, next_action: "browser_status" }),
        );
      }
      const forwarded = { ...args };
      delete forwarded.acknowledge_upgrade_notice;
      let result;
      try {
        result = await this.operations.rpc(
          this.meta,
          "tool",
          { session_id: this.session, name, args: forwarded },
          60000,
        );
      } catch (error) {
        // The tool might already have caused side effects. Reconnect only on a
        // later call; never retry this request after a daemon/session change.
        if (/Session expired|会话|fetch failed|shutting down/i.test(error.message)) await this.forget();
        throw error;
      }
      if (name === "browser_status") {
        const issues = result.extension_issues ?? [];
        const mismatch = issues.filter((i) => (i.reason ?? i.code) === "extension_update_required");
        const needsPlugin = mismatch.some((i) => i.required_action === "plugin_update_or_reload");
        return {
          ...result,
          runtime: mismatch.length
            ? {
                ...runtime,
                state: needsPlugin ? "plugin_update_required" : "extension_update_required",
                component: needsPlugin ? "cdpHelper plugin" : "cdpHelper 浏览器扩展",
                extension_issues: issues,
              }
            : runtime,
        };
      }
      return result;
    });
  }
  async heartbeat() {
    if (this.closed || !this.meta || !this.session) return;
    try {
      await this.operations.rpc(this.meta, "heartbeat", { session_id: this.session }, 5000);
    } catch {
      /* surfaced by next tool status; no background downgrade */
    }
  }
  async close() {
    this.closed = true;
    await this.forget();
  }
}
