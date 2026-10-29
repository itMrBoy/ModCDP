import { randomUUID } from "node:crypto";
import { mkdir, writeFile, open, stat } from "node:fs/promises";
import path from "node:path";

const MiB = 1024 * 1024;
const BODY_LIMIT = 256 * 1024;
const MEMORY_LIMIT = 32 * MiB;
const TRACE_LIMIT = 100 * MiB;
const clip = (value, size = 8192) => String(value ?? "").slice(0, size);
const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value));
const boundedTime = (value, fallback, maximum) => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error("Invalid capture duration.");
  return result;
};
const deadline = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Fixed code executed only in the page's own isolated world. No user code or
// bindings into Node/the extension are exposed by this collector.
function performanceCollector(command) {
  const key = "__cdphelperPerformance";
  if (command === "install") {
    globalThis[key]?.observers.forEach((observer) => observer.disconnect());
    const data = {
      long_tasks: [],
      layout_shifts: [],
      largest_contentful_paint: null,
      long_tasks_dropped: 0,
      layout_shifts_dropped: 0,
    };
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const observers = [];
    for (const type of ["longtask", "layout-shift", "largest-contentful-paint"]) {
      if (!supported.includes(type)) continue;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (type === "longtask") {
            if (data.long_tasks.length < 1000)
              data.long_tasks.push({ startTime: entry.startTime, duration: entry.duration });
            else data.long_tasks_dropped++;
          }
          if (type === "layout-shift") {
            if (data.layout_shifts.length < 1000)
              data.layout_shifts.push({
                startTime: entry.startTime,
                value: entry.value,
                hadRecentInput: entry.hadRecentInput,
              });
            else data.layout_shifts_dropped++;
          }
          if (type === "largest-contentful-paint")
            data.largest_contentful_paint = { startTime: entry.startTime, size: entry.size, provisional: true };
        }
      });
      observer.observe({ type, buffered: true });
      observers.push(observer);
    }
    globalThis[key] = { data, supported, observers };
  }
  if (command === "dispose") {
    globalThis[key]?.observers.forEach((observer) => observer.disconnect());
    delete globalThis[key];
    return;
  }
  const collection = globalThis[key];
  return {
    url: location.href,
    time_origin: performance.timeOrigin,
    collected_at: Date.now(),
    scope: "top_level_document",
    navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
    paint: performance.getEntriesByType("paint").map((entry) => entry.toJSON()),
    resources: performance
      .getEntriesByType("resource")
      .slice(-1000)
      .map((entry) => entry.toJSON()),
    resources_truncated: performance.getEntriesByType("resource").length > 1000,
    resources_dropped: Math.max(0, performance.getEntriesByType("resource").length - 1000),
    supported_entry_types: collection?.supported ?? [],
    ...(collection?.data ?? {}),
  };
}

export class Diagnostics {
  constructor({ home, openTraceFile = open }) {
    this.directory = path.join(home, "diagnostics");
    this.openTraceFile = openTraceFile;
    this.captures = new Map();
    this.traces = new Map();
    this.traceLocks = new Map();
    this.closing = false;
  }

  owned(map, owner, id) {
    const record = map.get(id);
    if (!record || record.owner !== owner) throw new Error("Capture reference expired or belongs to another session.");
    return record;
  }

  summary(capture) {
    return {
      capture_id: capture.id,
      tab_id: capture.tab_id,
      instance_id: capture.instance_id,
      url: capture.url,
      started_at: capture.started_at,
      stopped_at: capture.stopped_at ?? null,
      state: capture.state,
      stop_reason: capture.stop_reason ?? null,
      counts: {
        requests: capture.requests.length,
        console: capture.logs.length,
        completed: capture.requests.filter((r) => r.state === "completed").length,
        failed: capture.requests.filter((r) => r.state === "failed").length,
        pending: capture.requests.filter((r) => r.state === "pending").length,
      },
      dropped: { ...capture.dropped },
      bytes_retained: capture.bytes,
      complete:
        capture.state === "stopped" &&
        ["requested", "duration_elapsed"].includes(capture.stop_reason) &&
        !capture.requests.some((r) => r.state === "pending") &&
        !capture.dropped.requests &&
        !capture.dropped.console &&
        !capture.performanceError,
    };
  }

  ownerBytes(owner) {
    return [...this.captures.values()].filter((c) => c.owner === owner).reduce((sum, c) => sum + c.bytes, 0);
  }

  evictStopped(owner, except) {
    const oldest = [...this.captures.values()]
      .filter((c) => c.owner === owner && c.state !== "recording" && c !== except)
      .sort((a, b) => a.stopped_at - b.stopped_at)[0];
    if (!oldest) return false;
    this.captures.delete(oldest.id);
    return true;
  }

  reserve(capture, bytes) {
    while (this.ownerBytes(capture.owner) + bytes > MEMORY_LIMIT) {
      if (!this.evictStopped(capture.owner, capture)) return false;
    }
    capture.bytes += bytes;
    return true;
  }

  append(capture, kind, value) {
    if (capture.state !== "recording") return false;
    const list = kind === "requests" ? capture.requests : capture.logs;
    if (list.length >= 10000 || !this.reserve(capture, sizeOf(value) + (kind === "requests" ? 2048 : 0))) {
      capture.dropped[kind]++;
      return false;
    }
    list.push(value);
    return true;
  }

  async start(owner, { tab_id, instance_id, page, duration_ms }) {
    if (this.closing) throw new Error("Diagnostics is closing.");
    if (!/^https?:\/\//i.test(page.url())) throw new Error("Diagnostics requires an HTTP(S) page.");
    if ([...this.captures.values()].some((c) => c.tab_id === tab_id && c.state === "recording"))
      throw new Error("This tab already has an active diagnostic capture.");
    const duration = boundedTime(duration_ms, 60000, 300000);
    while ([...this.captures.values()].filter((c) => c.owner === owner).length >= 5)
      if (!this.evictStopped(owner)) throw new Error("Session already has five active captures.");
    const capture = {
      id: randomUUID(),
      owner,
      tab_id,
      instance_id,
      page,
      url: page.url(),
      started_at: Date.now(),
      state: "recording",
      requests: [],
      logs: [],
      requestRefs: new Map(),
      responses: new Map(),
      bytes: 0,
      dropped: { requests: 0, console: 0 },
      listeners: [],
      metrics: [],
      performanceError: null,
    };
    this.captures.set(capture.id, capture);
    const listen = (event, handler) => {
      page.on(event, handler);
      capture.listeners.push([event, handler]);
    };
    listen("request", (request) => {
      const record = {
        request_id: randomUUID(),
        url: clip(request.url()),
        method: request.method(),
        resource_type: request.resourceType(),
        started_at: Date.now(),
        state: "pending",
        status: null,
        timing: null,
        duration_ms: null,
        ttfb_ms: null,
        failure: null,
        cache_status: "unknown",
        redirected_from: capture.requestRefs.get(request.redirectedFrom())?.request_id ?? null,
      };
      if (this.append(capture, "requests", record)) capture.requestRefs.set(request, record);
    });
    listen("response", (response) => {
      const record = capture.requestRefs.get(response.request());
      if (!record || capture.state !== "recording") return;
      record.status = response.status();
      record.from_service_worker = response.fromServiceWorker?.() ?? false;
      capture.responses.set(record.request_id, response);
    });
    const finish = (request, failed) => {
      const record = capture.requestRefs.get(request);
      if (!record || capture.state !== "recording") return;
      const timing = request.timing();
      const extra = {
        state: failed ? "failed" : "completed",
        finished_at: Date.now(),
        timing,
        duration_ms: timing.responseEnd >= 0 ? timing.responseEnd : null,
        ttfb_ms:
          timing.responseStart >= 0 && timing.requestStart >= 0 ? timing.responseStart - timing.requestStart : null,
        failure: failed ? clip(request.failure()?.errorText) : null,
      };
      if (this.reserve(capture, sizeOf(extra))) Object.assign(record, extra);
      else {
        capture.dropped.requests++;
        record.state = failed ? "failed" : "completed";
        record.details_truncated = true;
      }
    };
    listen("requestfinished", (request) => finish(request, false));
    listen("requestfailed", (request) => finish(request, true));
    listen("console", (message) =>
      this.append(capture, "console", {
        timestamp: Date.now(),
        level: message.type(),
        text: clip(message.text(), 16384),
        location: message.location(),
      }),
    );
    listen("pageerror", (error) =>
      this.append(capture, "console", {
        timestamp: Date.now(),
        level: "error",
        text: clip(error.message, 16384),
        stack: clip(error.stack, 16384),
        uncaught: true,
      }),
    );
    listen("close", () => {
      void this.stop(capture, "page_closed");
    });
    listen("domcontentloaded", () => {
      void this.readMetrics(capture);
    });
    capture.timer = setTimeout(() => {
      void this.stop(capture, "duration_elapsed");
    }, duration);
    capture.timer.unref?.();
    capture.metricsTimer = setInterval(() => {
      void this.readMetrics(capture);
    }, 2000);
    capture.metricsTimer.unref?.();
    capture.setup = (async () => {
      try {
        capture.cdp = await deadline(page.context().newCDPSession(page), 10000, "Performance session timeout");
        if (capture.state !== "recording") return;
        capture.world = `cdphelper-performance-${capture.id}`;
        const { identifier } = await capture.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: `(${performanceCollector.toString()})("install")`,
          worldName: capture.world,
        });
        capture.script = identifier;
        await capture.cdp.send("Performance.enable");
        await this.readMetrics(capture, true);
      } catch (error) {
        capture.performanceError = error.message;
      }
    })();
    await capture.setup;
    return this.summary(capture);
  }

  async worldCommand(capture, command) {
    const { frameTree } = await capture.cdp.send("Page.getFrameTree");
    const { executionContextId } = await capture.cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: capture.world,
    });
    const result = await capture.cdp.send("Runtime.evaluate", {
      expression: `(${performanceCollector.toString()})(${JSON.stringify(command)})`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("Page performance collector failed.");
    return result.result?.value;
  }

  async readMetrics(capture, install = false) {
    if (!capture.cdp || capture.state !== "recording") return;
    if (capture.readingMetrics) return capture.readingMetrics;
    capture.readingMetrics = this.collectMetrics(capture, install).finally(() => {
      capture.readingMetrics = null;
    });
    return capture.readingMetrics;
  }

  async collectMetrics(capture, install) {
    try {
      const metrics = await deadline(
        (async () => {
          const pageMetrics = await this.worldCommand(capture, install ? "install" : "read");
          const runtime = await capture.cdp.send("Performance.getMetrics");
          return { ...pageMetrics, runtime_metrics: runtime.metrics };
        })(),
        5000,
        "Performance metrics timeout",
      );
      if (capture.state !== "recording") return;
      if (metrics.resources_truncated || metrics.long_tasks_dropped || metrics.layout_shifts_dropped)
        capture.performanceError = "Performance entries exceeded the per-document retention limit; data is incomplete.";
      const previous = capture.metrics.findIndex((m) => m.time_origin === metrics.time_origin);
      if (previous < 0 && capture.metrics.length >= 20) {
        capture.performanceError = "Only the first 20 document performance records are retained.";
        return;
      }
      const previousSize = previous >= 0 ? sizeOf(capture.metrics[previous]) : 0;
      const change = sizeOf(metrics) - previousSize;
      if (change <= 0 || this.reserve(capture, change)) {
        if (change < 0) capture.bytes += change;
        if (previous >= 0) capture.metrics[previous] = metrics;
        else capture.metrics.push(metrics);
      } else {
        capture.performanceError = "Performance snapshot exceeded the session memory limit.";
      }
    } catch (error) {
      capture.performanceError = error.message;
    }
  }

  async stop(capture, reason = "requested") {
    if (capture.stopping) return capture.stopping;
    if (capture.state !== "recording") return this.summary(capture);
    clearTimeout(capture.timer);
    clearInterval(capture.metricsTimer);
    for (const [event, handler] of capture.listeners) capture.page.off(event, handler);
    capture.listeners = [];
    capture.state = "stopped";
    capture.stop_reason = reason;
    capture.stopped_at = Date.now();
    capture.stopping = (async () => {
      await capture.setup;
      if (capture.cdp) {
        await deadline(
          (async () => {
            if (capture.script)
              await capture.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: capture.script });
            await this.worldCommand(capture, "dispose");
          })(),
          3000,
          "Performance cleanup timeout",
        ).catch((error) => {
          capture.performanceError ??= error.message;
        });
        await capture.cdp.detach().catch(() => {});
        capture.cdp = null;
      }
      return this.summary(capture);
    })();
    return capture.stopping;
  }

  page(records, args) {
    const offset = args.offset ?? 0,
      limit = args.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Invalid result pagination.");
    const items = [];
    let bytes = 0;
    for (const record of records.slice(offset, offset + limit)) {
      const size = sizeOf(record);
      if (bytes + size > BODY_LIMIT) break;
      items.push(record);
      bytes += size;
    }
    return {
      total: records.length,
      offset,
      limit,
      items,
      next_offset: offset + items.length < records.length ? offset + items.length : null,
    };
  }

  async call(owner, name, args) {
    if (name === "browser_performance_trace_stop" || name === "browser_performance_trace_status") {
      const trace = this.owned(this.traces, owner, args.trace_id);
      if (name.endsWith("_stop")) this.stopTrace(trace, "requested");
      return this.traceSummary(trace);
    }
    const capture = this.owned(this.captures, owner, args.capture_id);
    if (name === "browser_diagnostics_stop") {
      await this.readMetrics(capture);
      return this.stop(capture);
    }
    if (name === "browser_network_requests") {
      let records = capture.requests.filter(
        (record) =>
          (!args.url_contains || record.url.includes(args.url_contains)) &&
          (args.status == null || record.status === args.status) &&
          (!args.state || record.state === args.state),
      );
      if (args.sort === "duration_desc") {
        const duration = (record) =>
          record.state === "completed" &&
          typeof record.duration_ms === "number" &&
          Number.isFinite(record.duration_ms) &&
          record.duration_ms >= 0
            ? record.duration_ms
            : -1;
        records = [...records].sort((a, b) => duration(b) - duration(a));
      }
      return { ...this.page(records, args), capture: this.summary(capture) };
    }
    if (name === "browser_console_messages")
      return {
        ...this.page(
          capture.logs.filter((log) => !args.level || log.level === args.level),
          args,
        ),
        capture: this.summary(capture),
      };
    if (name === "browser_performance_metrics") {
      await this.readMetrics(capture);
      return {
        capture: this.summary(capture),
        documents: capture.metrics,
        unavailable_reason: capture.performanceError,
      };
    }
    if (name === "browser_network_request") return this.requestDetail(capture, args);
    if (name === "browser_diagnostics_export") {
      await this.readMetrics(capture);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, `${capture.id}.json`);
      await writeFile(
        file,
        JSON.stringify(
          {
            capture: this.summary(capture),
            requests: capture.requests,
            console: capture.logs,
            performance: capture.metrics,
            performance_unavailable_reason: capture.performanceError,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return {
        path: file,
        bytes: (await stat(file)).size,
        complete: this.summary(capture).complete,
        capture_id: capture.id,
      };
    }
    throw new Error(`Unknown diagnostics tool: ${name}`);
  }

  async requestDetail(capture, args) {
    const entry = [...capture.requestRefs.entries()].find(([, record]) => record.request_id === args.request_id);
    if (!entry) throw new Error("Unknown request in this capture.");
    const [request, record] = entry;
    const response = capture.responses.get(record.request_id);
    const result = { ...record, request_headers: request.headers(), response_headers: response?.headers() ?? null };
    try {
      if (request.allHeaders)
        result.request_headers = await deadline(request.allHeaders(), 3000, "Request header timeout");
      if (response?.allHeaders)
        result.response_headers = await deadline(response.allHeaders(), 3000, "Response header timeout");
    } catch (error) {
      result.headers_unavailable_reason = error.message;
    }
    for (const key of ["request_headers", "response_headers"]) {
      if (sizeOf(result[key]) > 64 * 1024) {
        const headers = {};
        for (const [name, value] of Object.entries(result[key])) {
          headers[clip(name, 256)] = clip(value, 4096);
          if (sizeOf(headers) > 60 * 1024) {
            delete headers[clip(name, 256)];
            break;
          }
        }
        result[key] = headers;
        result.headers_truncated = true;
      }
    }
    if (args.include_request_body) {
      const body = request.postDataBuffer();
      result.request_body = body
        ? this.bodyResult(body, request.headers()["content-type"])
        : { available: false, reason: "No request body." };
    }
    if (args.include_response_body) {
      try {
        if (!response || record.state !== "completed")
          throw new Error("Response body is not available for an incomplete request.");
        const length = Number(response.headers()["content-length"]);
        if (Number.isFinite(length) && length > BODY_LIMIT) throw new Error("Response exceeds the 256 KiB body limit.");
        result.response_body = this.bodyResult(
          await deadline(response.body(), 5000, "Response body timeout"),
          response.headers()["content-type"],
        );
      } catch (error) {
        result.response_body = { available: false, reason: error.message };
      }
    }
    return result;
  }

  bodyResult(body, contentType = "") {
    const textual = /text|json|javascript|xml|form-urlencoded/i.test(contentType);
    const maximum = textual ? BODY_LIMIT : Math.floor((BODY_LIMIT * 3) / 4);
    const truncated = body.length > maximum;
    const result = {
      available: true,
      encoding: textual ? "utf8" : "base64",
      bytes: body.length,
      truncated,
      data: body.subarray(0, maximum).toString(textual ? "utf8" : "base64"),
    };
    if (sizeOf(result) > BODY_LIMIT) {
      const data = result.data;
      let low = 0,
        high = data.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        result.data = data.slice(0, middle);
        if (sizeOf(result) <= BODY_LIMIT - 32) low = middle;
        else high = middle - 1;
      }
      const length = textual ? low : low - (low % 4);
      result.data = data.slice(0, length);
      result.truncated = true;
    }
    return result;
  }

  traceSummary(trace) {
    return {
      trace_id: trace.id,
      tab_id: trace.tab_id,
      instance_id: trace.instance_id,
      url: trace.url,
      state: trace.state,
      started_at: trace.started_at,
      stopped_at: trace.stopped_at ?? null,
      stop_reason: trace.reason ?? null,
      path: trace.path ?? null,
      bytes: trace.bytes ?? 0,
      complete: trace.state === "completed",
      error: trace.error ?? null,
      scope: "Started from the bound page; shared process activity may be included.",
    };
  }

  async startTrace(owner, { tab_id, instance_id, page, duration_ms }) {
    if (this.closing) throw new Error("Diagnostics is closing.");
    if (!/^https?:\/\//i.test(page.url())) throw new Error("Tracing requires an HTTP(S) page.");
    const duration = boundedTime(duration_ms, 10000, 60000);
    if (this.traceLocks.has(instance_id)) throw new Error("Trace busy: this browser instance already has a recording.");
    const existing = [...this.traces.values()].filter((trace) => trace.owner === owner);
    if (existing.length >= 5) {
      const oldest = existing.find((trace) => ["completed", "failed"].includes(trace.state));
      if (!oldest) throw new Error("Session already has five active Trace records.");
      this.traces.delete(oldest.id);
    }
    const trace = {
      id: randomUUID(),
      owner,
      tab_id,
      instance_id,
      url: page.url(),
      started_at: Date.now(),
      state: "starting",
      bytes: 0,
    };
    trace.ready = new Promise((resolve) => {
      trace.resolveReady = resolve;
    });
    this.traceLocks.set(instance_id, trace.id);
    this.traces.set(trace.id, trace);
    try {
      trace.cdp = await deadline(page.context().newCDPSession(page), 10000, "Trace session timeout");
      trace.completion = new Promise((resolve) => {
        trace.resolveCompletion = resolve;
      });
      trace.onComplete = (event) => trace.resolveCompletion(event);
      trace.onDetach = () => {
        trace.resolveCompletion({ error: "Trace session disconnected before export completed." });
        this.stopTrace(trace, "disconnected");
      };
      trace.cdp.on("Tracing.tracingComplete", trace.onComplete);
      trace.cdp.on("Disconnected", trace.onDetach);
      await trace.cdp.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        streamFormat: "json",
        categories:
          "devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler",
      });
      trace.state = "recording";
      trace.timer = setTimeout(() => this.stopTrace(trace, "duration_elapsed"), duration);
      trace.timer.unref?.();
      if (trace.pendingStop) this.stopTrace(trace, trace.pendingStop);
      return this.traceSummary(trace);
    } catch (error) {
      trace.error = error.message;
      trace.stopped_at = Date.now();
      trace.cdp?.off("Tracing.tracingComplete", trace.onComplete);
      trace.cdp?.off("Disconnected", trace.onDetach);
      await trace.cdp?.detach().catch(() => {});
      if (this.traceLocks.get(instance_id) === trace.id) this.traceLocks.delete(instance_id);
      trace.state = "failed";
      throw new Error(`Could not start Trace (possibly busy or unsupported): ${error.message}`);
    } finally {
      trace.resolveReady();
    }
  }

  stopTrace(trace, reason) {
    if (trace.state === "starting") {
      trace.pendingStop ??= reason;
      return;
    }
    if (trace.state !== "recording") return;
    trace.state = "finalizing";
    trace.reason = reason;
    clearTimeout(trace.timer);
    trace.finalizing = (async () => {
      try {
        await this.finishTrace(trace);
      } catch (error) {
        trace.error = error.message;
      } finally {
        trace.stopped_at = Date.now();
        trace.cdp.off("Tracing.tracingComplete", trace.onComplete);
        trace.cdp.off("Disconnected", trace.onDetach);
        await trace.cdp.detach().catch(() => {});
        if (this.traceLocks.get(trace.instance_id) === trace.id) this.traceLocks.delete(trace.instance_id);
        trace.state = trace.error ? "failed" : "completed";
      }
    })();
  }

  async finishTrace(trace) {
    let file, stream;
    try {
      await deadline(trace.cdp.send("Tracing.end"), 5000, "Trace stop timeout");
      const completion = await deadline(trace.completion, 20000, "Trace completion timeout");
      if (completion.error) throw new Error(completion.error);
      stream = completion.stream;
      if (!stream || completion.dataLossOccurred)
        throw new Error("Trace stream unavailable or browser reported data loss.");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      trace.path = path.join(this.directory, `${trace.id}.trace.json`);
      file = await this.openTraceFile(trace.path, "wx", 0o600);
      const exportDeadline = Date.now() + 30000;
      while (true) {
        if (Date.now() > exportDeadline) throw new Error("Trace export timeout.");
        const chunk = await deadline(
          trace.cdp.send("IO.read", { handle: stream, size: MiB }),
          5000,
          "Trace stream read timeout",
        );
        const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        if (trace.bytes + buffer.length > TRACE_LIMIT)
          throw new Error("Trace exceeds the 100 MiB file limit; export is incomplete.");
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
          if (!Number.isInteger(bytesWritten) || bytesWritten <= 0)
            throw new Error("Trace file write made no progress.");
          offset += bytesWritten;
        }
        trace.bytes += buffer.length;
        if (chunk.eof) break;
      }
      if (!["requested", "duration_elapsed"].includes(trace.reason))
        trace.error = `Recording interrupted: ${trace.reason}`;
    } finally {
      try {
        await file?.close();
      } finally {
        if (stream) await deadline(trace.cdp.send("IO.close", { handle: stream }), 5000, "Trace stream close timeout");
      }
    }
  }

  async releaseTab(tab_id, reason = "released") {
    const stopping = [...this.captures.values()]
      .filter((c) => c.tab_id === tab_id && c.state === "recording")
      .map((c) => this.stop(c, reason));
    for (const trace of this.traces.values()) if (trace.tab_id === tab_id) this.stopTrace(trace, reason);
    await Promise.allSettled(stopping);
  }

  async dropSession(owner) {
    await Promise.allSettled(
      [...this.captures.values()].filter((c) => c.owner === owner).map((c) => this.stop(c, "session_closed")),
    );
    for (const trace of this.traces.values()) if (trace.owner === owner) this.stopTrace(trace, "session_closed");
    await Promise.allSettled([...this.traces.values()].filter((t) => t.owner === owner).map((t) => t.ready));
    await Promise.allSettled([...this.traces.values()].filter((t) => t.owner === owner).map((t) => t.finalizing));
    for (const [id, c] of this.captures) if (c.owner === owner) this.captures.delete(id);
    for (const [id, t] of this.traces) if (t.owner === owner) this.traces.delete(id);
  }

  async close() {
    this.closing = true;
    const owners = new Set([...this.captures.values(), ...this.traces.values()].map((c) => c.owner));
    await Promise.allSettled([...owners].map((owner) => this.dropSession(owner)));
  }
}
