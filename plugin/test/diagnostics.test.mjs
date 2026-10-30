import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile, open } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { Diagnostics } from "../src/diagnostics.mjs";

class Session extends EventEmitter {
  constructor() {
    super();
    this.commands = [];
    this.trace = Buffer.from('{"traceEvents":[{"name":"fixture"}]}');
  }
  async send(method, args) {
    this.commands.push([method, args]);
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") return { result: { value: { time_origin: 1, scope: "top_level_document" } } };
    if (method === "Performance.getMetrics") return { metrics: [{ name: "Nodes", value: 4 }] };
    if (method === "Tracing.start" && this.busy) throw new Error("Another trace is running");
    if (method === "Tracing.end")
      queueMicrotask(() => this.emit("Tracing.tracingComplete", { stream: "fixture-stream" }));
    if (method === "IO.read") return { data: this.trace.toString("base64"), base64Encoded: true, eof: true };
    return {};
  }
  async detach() {
    this.detached = true;
  }
}

class Page extends EventEmitter {
  constructor() {
    super();
    this.sessions = [];
  }
  url() {
    return "https://example.test/page";
  }
  context() {
    return {
      newCDPSession: async () => {
        const cdp = new Session();
        this.sessions.push(cdp);
        return cdp;
      },
    };
  }
}

function request(url, options = {}) {
  return {
    url: () => url,
    method: () => options.method ?? "GET",
    resourceType: () => "fetch",
    redirectedFrom: () => options.redirectedFrom ?? null,
    timing: () => options.timing ?? { requestStart: 1, responseStart: 21, responseEnd: 40 },
    failure: () => ({ errorText: "net::ERR_FAILED" }),
    headers: () => ({ "content-type": "application/json" }),
    postDataBuffer: () => (options.body ? Buffer.from(options.body) : null),
  };
}

const consoleMessage = (text, level = "log") => ({
  type: () => level,
  text: () => text,
  location: () => ({ url: "fixture.js", lineNumber: 2 }),
});
async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cdphelper-diagnostics-"));
  const diagnostics = new Diagnostics({ home: directory, ...options });
  try {
    await run(diagnostics, new Page());
  } finally {
    await diagnostics.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("network lifecycle, redirect links, console, ownership and stopped exports", async () =>
  fixture(async (d, page) => {
    const { capture_id } = await d.start("alice", { tab_id: "tab", instance_id: "instance", page });
    const first = request("https://example.test/start");
    const second = request("https://example.test/end", { redirectedFrom: first, method: "POST", body: '{"ok":true}' });
    const failed = request("https://example.test/fail", {
      timing: { requestStart: -1, responseStart: -1, responseEnd: -1 },
    });
    for (const req of [first, second, failed]) page.emit("request", req);
    page.emit("response", { request: () => first, status: () => 302, headers: () => ({}) });
    page.emit("requestfinished", first);
    page.emit("response", {
      request: () => second,
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from('{"response":true}'),
    });
    page.emit("requestfinished", second);
    page.emit("requestfailed", failed);
    page.emit("console", consoleMessage("hello"));
    page.emit("pageerror", new Error("uncaught fixture"));
    await assert.rejects(d.call("bob", "browser_console_messages", { capture_id }), /another session/);
    const list = await d.call("alice", "browser_network_requests", { capture_id, sort: "duration_desc" });
    assert.equal(list.items.length, 3);
    assert.equal(list.items[1].redirected_from, list.items[0].request_id);
    assert.equal(list.items[0].duration_ms, 40);
    assert.equal(list.items[0].ttfb_ms, 20);
    assert.equal(list.items[2].duration_ms, null);
    assert.equal(list.items[2].failure, "net::ERR_FAILED");
    const detail = await d.call("alice", "browser_network_request", {
      capture_id,
      request_id: list.items[1].request_id,
      include_request_body: true,
      include_response_body: true,
    });
    assert.equal(detail.request_body.data, '{"ok":true}');
    assert.equal(detail.response_body.data, '{"response":true}');
    const stopped = await d.call("alice", "browser_diagnostics_stop", { capture_id });
    assert.equal(stopped.complete, true);
    assert.equal(page.listenerCount("request"), 0);
    page.emit("console", consoleMessage("too late"));
    const logs = await d.call("alice", "browser_console_messages", { capture_id });
    assert.equal(logs.items.length, 2);
    assert.equal(logs.items[1].uncaught, true);
    const result = await d.call("alice", "browser_diagnostics_export", { capture_id });
    assert.ok(result.bytes > 0);
    assert.equal(JSON.parse(await readFile(result.path, "utf8")).requests.length, 3);
    assert.ok(page.sessions[0].commands.some(([method]) => method === "Page.removeScriptToEvaluateOnNewDocument"));
    assert.ok(!page.sessions[0].commands.some(([method]) => /^(Network|Runtime|Performance)\.disable$/.test(method)));
  }));

test("release immediately detaches listeners and keeps incomplete results queryable", async () =>
  fixture(async (d, page) => {
    const { capture_id } = await d.start("owner", { tab_id: "tab", instance_id: "instance", page });
    page.emit("request", request("https://example.test/pending"));
    const pending = d.releaseTab("tab", "human_stopped");
    assert.equal(page.listenerCount("request"), 0);
    assert.equal(d.captures.get(capture_id).state, "stopped");
    await pending;
    const data = await d.call("owner", "browser_network_requests", { capture_id });
    assert.equal(data.capture.stop_reason, "human_stopped");
    assert.equal(data.capture.complete, false);
    assert.equal(data.capture.counts.pending, 1);
  }));

test("capture limits, pagination, stopped eviction and unknown bodies are explicit", async () =>
  fixture(async (d, page) => {
    const { capture_id } = await d.start("owner", { tab_id: "tab", instance_id: "instance", page });
    for (let i = 0; i < 10001; i++) page.emit("console", consoleMessage(`item${i}`));
    const data = await d.call("owner", "browser_console_messages", { capture_id, offset: 9990, limit: 20 });
    assert.equal(data.total, 10000);
    assert.equal(data.items.length, 10);
    assert.equal(data.capture.dropped.console, 1);
    await assert.rejects(d.call("owner", "browser_console_messages", { capture_id, limit: 201 }), /pagination/);
    assert.ok(d.ownerBytes("owner") <= 32 * 1024 * 1024);
    await d.call("owner", "browser_diagnostics_stop", { capture_id });
    for (let i = 0; i < 5; i++) {
      const record = await d.start("owner", { tab_id: "tab", instance_id: "instance", page });
      await d.call("owner", "browser_diagnostics_stop", record);
    }
    await assert.rejects(d.call("owner", "browser_console_messages", { capture_id }), /expired/);
    assert.equal(d.captures.size, 5);
    const body = d.bodyResult(Buffer.alloc(300000, "a"), "text/plain");
    assert.equal(body.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 256 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(d.bodyResult(Buffer.alloc(256 * 1024, 1), "text/plain"))) <= 256 * 1024);
  }));

test("Trace ownership, asynchronous export, stream close and instance lock recovery", async () =>
  fixture(async (d, page) => {
    const first = await d.startTrace("alice", { tab_id: "tab", instance_id: "instance", page });
    await assert.rejects(d.startTrace("bob", { tab_id: "other", instance_id: "instance", page }), /busy/);
    await assert.rejects(d.call("bob", "browser_performance_trace_stop", first), /another session/);
    assert.equal((await d.call("alice", "browser_performance_trace_stop", first)).state, "finalizing");
    const trace = d.traces.get(first.trace_id);
    await trace.finalizing;
    const result = await d.call("alice", "browser_performance_trace_status", first);
    assert.equal(result.state, "completed");
    assert.equal(JSON.parse(await readFile(result.path, "utf8")).traceEvents[0].name, "fixture");
    assert.ok(page.sessions[0].commands.some(([method]) => method === "IO.close"));
    const second = await d.startTrace("bob", { tab_id: "other", instance_id: "instance", page });
    await d.releaseTab("other", "human_stopped");
    await d.traces.get(second.trace_id).finalizing;
    const interrupted = await d.call("bob", "browser_performance_trace_status", second);
    assert.equal(interrupted.complete, false);
    assert.equal(interrupted.stop_reason, "human_stopped");
    assert.equal(d.traceLocks.size, 0);
  }));

test("duration stops automatically and dropSession removes owner data", async () =>
  fixture(async (d, page) => {
    const record = await d.start("alice", { tab_id: "tab", instance_id: "instance", page, duration_ms: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(d.captures.get(record.capture_id).state, "stopped");
    await d.dropSession("alice");
    assert.equal(d.captures.size, 0);
  }));

test("Trace overflow remains incomplete, closes its stream and releases its lock", async () =>
  fixture(async (d, page) => {
    const record = await d.startTrace("owner", { tab_id: "tab", instance_id: "instance", page });
    const trace = d.traces.get(record.trace_id);
    trace.bytes = 100 * 1024 * 1024;
    await d.call("owner", "browser_performance_trace_stop", record);
    await trace.finalizing;
    const result = await d.call("owner", "browser_performance_trace_status", record);
    assert.equal(result.state, "failed");
    assert.equal(result.complete, false);
    assert.match(result.error, /100 MiB/);
    assert.ok(page.sessions[0].commands.some(([method]) => method === "IO.close"));
    assert.equal(d.traceLocks.size, 0);
  }));

test("partial file writes are completed and terminal Trace state waits for IO close and lock release", async () => {
  await fixture(
    async (d, page) => {
      const record = await d.startTrace("owner", { tab_id: "tab", instance_id: "instance", page });
      const trace = d.traces.get(record.trace_id);
      const session = page.sessions[0];
      const originalSend = session.send.bind(session);
      let releaseClose, enteredClose;
      const closeEntered = new Promise((resolve) => {
        enteredClose = resolve;
      });
      const closeAllowed = new Promise((resolve) => {
        releaseClose = resolve;
      });
      session.send = async (method, args) => {
        if (method === "IO.close") {
          enteredClose();
          await closeAllowed;
        }
        return originalSend(method, args);
      };
      await d.call("owner", "browser_performance_trace_stop", record);
      await closeEntered;
      const duringClose = await d.call("owner", "browser_performance_trace_status", record);
      assert.equal(duringClose.state, "finalizing");
      assert.equal(duringClose.complete, false);
      await assert.rejects(d.startTrace("other", { tab_id: "other", instance_id: "instance", page }), /busy/);
      assert.equal(await readFile(trace.path, "utf8"), session.trace.toString());
      releaseClose();
      await trace.finalizing;
      assert.equal((await d.call("owner", "browser_performance_trace_status", record)).state, "completed");
      assert.equal(d.traceLocks.size, 0);
      await d.startTrace("other", { tab_id: "other", instance_id: "instance", page });
    },
    {
      openTraceFile: async (...args) => {
        const file = await open(...args);
        return {
          write: (buffer, offset, length) => file.write(buffer, offset, Math.min(3, length)),
          close: () => file.close(),
        };
      },
    },
  );
});

test("Performance observer and resource truncation are counted and invalidate export completeness", async () =>
  fixture(async (d, page) => {
    const observers = [];
    class Observer {
      static supportedEntryTypes = ["longtask", "layout-shift"];
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe({ type }) {
        this.type = type;
      }
      disconnect() {}
    }
    const resources = Array.from({ length: 1001 }, () => ({ toJSON: () => ({ name: "fixture.js" }) }));
    const sandbox = {
      PerformanceObserver: Observer,
      location: { href: page.url() },
      performance: { timeOrigin: 1, getEntriesByType: (type) => (type === "resource" ? resources : []) },
    };
    const session = new Session();
    const originalSend = session.send.bind(session);
    session.send = async (method, args) => {
      if (method === "Runtime.evaluate") return { result: { value: runInNewContext(args.expression, sandbox) } };
      return originalSend(method, args);
    };
    page.context = () => ({ newCDPSession: async () => session });
    const capture = await d.start("owner", { tab_id: "tab", instance_id: "instance", page });
    for (const observer of observers)
      observer.callback({
        getEntries: () => Array.from({ length: 1003 }, () => ({ startTime: 1, duration: 70, value: 0.1 })),
      });
    const metrics = await d.call("owner", "browser_performance_metrics", { capture_id: capture.capture_id });
    assert.equal(metrics.documents[0].long_tasks.length, 1000);
    assert.equal(metrics.documents[0].long_tasks_dropped, 3);
    assert.equal(metrics.documents[0].layout_shifts_dropped, 3);
    assert.equal(metrics.documents[0].resources_dropped, 1);
    assert.match(metrics.unavailable_reason, /incomplete/);
    const stopped = await d.call("owner", "browser_diagnostics_stop", { capture_id: capture.capture_id });
    assert.equal(stopped.complete, false);
    assert.equal(
      (await d.call("owner", "browser_diagnostics_export", { capture_id: capture.capture_id })).complete,
      false,
    );
  }));

test("slowest sorting only ranks completed requests with valid duration", async () =>
  fixture(async (d, page) => {
    const { capture_id } = await d.start("owner", { tab_id: "tab", instance_id: "instance", page });
    const failed = request("https://example.test/fail", {
      timing: { requestStart: 1, responseStart: 2, responseEnd: 9000 },
    });
    const success = request("https://example.test/ok");
    const pending = request("https://example.test/pending");
    for (const item of [failed, pending, success]) page.emit("request", item);
    page.emit("requestfailed", failed);
    page.emit("requestfinished", success);
    const result = await d.call("owner", "browser_network_requests", { capture_id, sort: "duration_desc" });
    assert.equal(result.items[0].url, "https://example.test/ok");
    assert.equal(result.items[1].state, "failed");
    assert.equal(result.items[2].state, "pending");
  }));

test(
  "independent Chromium: real network, console, cross-navigation metrics and DevTools Trace",
  { timeout: 60000 },
  async () => {
    const executable = process.env.SNOW_TEST_BROWSER ?? chromium.executablePath();
    assert.ok(
      existsSync(executable),
      "Install the locked Playwright test browser or set SNOW_TEST_BROWSER; this fixture is separate from real Snow acceptance.",
    );
    const server = http.createServer((req, res) => {
      if (req.url === "/data") {
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        }, 30);
      } else {
        res.setHeader("content-type", "text/html");
        res.end(
          '<title>Diagnostics fixture</title><h1>Fixture</h1><script>console.log("navigation fixture");</script>',
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      await fixture(async (d) => {
        const page = await browser.newPage();
        const url = `http://127.0.0.1:${server.address().port}`;
        await page.goto(url);
        const { capture_id } = await d.start("owner", { tab_id: "tab", instance_id: "instance", page });
        const capture = { capture_id };
        const trace = await d.startTrace("owner", { tab_id: "tab", instance_id: "instance", page });
        await page.evaluate(async () => {
          console.warn("console fixture");
          await fetch("/data");
          const end = performance.now() + 60;
          while (performance.now() < end) {
            /* Generate one observable long task. */
          }
        });
        const first = await d.call("owner", "browser_performance_metrics", capture);
        assert.equal(first.unavailable_reason, null);
        assert.equal(first.documents[0].scope, "top_level_document");
        assert.ok(first.documents[0].runtime_metrics.length > 0);
        await page.goto(`${url}/next`);
        const stopped = await d.call("owner", "browser_diagnostics_stop", capture);
        assert.equal(stopped.state, "stopped");
        const metrics = await d.call("owner", "browser_performance_metrics", capture);
        assert.equal(metrics.documents.length, 2);
        const logs = await d.call("owner", "browser_console_messages", capture);
        assert.ok(logs.items.some((entry) => entry.text === "console fixture"));
        const network = await d.call("owner", "browser_network_requests", capture);
        const data = network.items.find((entry) => entry.url.endsWith("/data"));
        assert.ok(data.duration_ms >= 20);
        const detail = await d.call("owner", "browser_network_request", {
          ...capture,
          request_id: data.request_id,
          include_response_body: true,
        });
        // Navigations may evict an old response body; either outcome is explicit.
        assert.equal(typeof detail.response_body.available, "boolean");
        await d.call("owner", "browser_performance_trace_stop", trace);
        await d.traces.get(trace.trace_id).finalizing;
        const result = await d.call("owner", "browser_performance_trace_status", trace);
        assert.equal(result.state, "completed", result.error);
        assert.ok(JSON.parse(await readFile(result.path, "utf8")).traceEvents.length > 0);
        assert.equal(page.listenerCount("request"), 0);
        assert.equal(await page.evaluate(() => document.querySelector("h1").textContent), "Fixture");
      });
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
