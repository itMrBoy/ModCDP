import { randomBytes } from "node:crypto";
import { instanceAppearance } from "./instance-appearance.mjs";

const TTL = 15000;
const HEARTBEAT = 4000;

// Runs only in this controller's isolated world. No page-supplied code is evaluated.
function installControl({ key, binding, token, generation, expiresAt, action, box, displayNumber, appearance }) {
  if (window.top !== window || Date.now() >= expiresAt) return false;
  const previous = globalThis[key];
  if (previous) {
    return previous.refresh({ expiresAt, action, box });
  }
  let host,
    shadow,
    bar,
    label,
    target,
    pointer,
    observer,
    disposed = false;
  let lease = expiresAt;
  let currentAction = action;
  let currentBox = box;
  const ripples = new Set();
  const remove = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    observer?.disconnect();
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", click, true);
    window.removeEventListener("pagehide", hide);
    document.removeEventListener("visibilitychange", visibility);
    host?.remove();
    if (globalThis[key] === state) delete globalThis[key];
  };
  const paint = () => {
    if (!label) return;
    label.textContent = currentAction || "正在控制此页面";
    if (!/点击|填写|按键|click|fill|press/i.test(currentAction || "")) pointer.style.display = "none";
    const hasBox =
      currentBox && [currentBox.x, currentBox.y, currentBox.width, currentBox.height].every(Number.isFinite);
    // Only stop receives pointer events. Keep the whole bar away from the
    // operation target so its stop button cannot obstruct Playwright's hit test.
    bar.style.top = "10px";
    if (hasBox) {
      const rect = bar.getBoundingClientRect();
      const gap = 8;
      if (
        rect.left < currentBox.x + currentBox.width + gap &&
        rect.right > currentBox.x - gap &&
        rect.top < currentBox.y + currentBox.height + gap &&
        rect.bottom > currentBox.y - gap
      ) {
        const bottom = Math.max(10, window.innerHeight - rect.height - 10);
        const below = currentBox.y + currentBox.height + gap;
        const above = currentBox.y - rect.height - gap;
        bar.style.top = `${below <= bottom ? Math.max(10, below) : above >= 10 ? above : bottom}px`;
      }
    }
    if (hasBox) {
      Object.assign(target.style, {
        display: "block",
        left: `${currentBox.x}px`,
        top: `${currentBox.y}px`,
        width: `${Math.max(0, currentBox.width)}px`,
        height: `${Math.max(0, currentBox.height)}px`,
      });
    } else target.style.display = "none";
  };
  const mount = () => {
    if (disposed || !document.documentElement) return;
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.setAttribute("data-cdphelper-control", generation);
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;display:block!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style!important;";
    shadow = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host{all:initial}*{box-sizing:border-box}
      .bar{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:8px 10px 8px 14px;border:1px solid #ffffff44;border-radius:12px;background:linear-gradient(110deg,#315cdb,#7357d9);box-shadow:0 4px 20px #303d6e44;color:white;font:13px/20px system-ui,sans-serif;pointer-events:none}
      .brand{font-weight:650;white-space:nowrap}.action{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40vw}.stop{all:unset;box-sizing:border-box;cursor:pointer;pointer-events:auto;flex-shrink:0;padding:3px 10px;border-radius:7px;background:#ffffff22;color:white;font:12px/20px system-ui,sans-serif}.stop:hover{background:#ffffff38}.stop:focus-visible{outline:2px solid white;outline-offset:2px}
      .instance-number{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;min-width:56px;padding:3px 12px;border:2px solid #fff;border-radius:999px;font:700 16px/24px system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 5px #0002}
      .target{display:none;position:fixed;border:2px solid #7775f6;border-radius:5px;background:#7775f615;pointer-events:none}
      .pointer{display:none;position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid #fff;border-radius:50%;background:#6559e9;box-shadow:0 0 0 1px #5e54cf,0 1px 5px #0005;pointer-events:none}
      .ripple{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border:2px solid #7775f6;border-radius:50%;background:#7775f622;pointer-events:none}
    `);
    shadow.adoptedStyleSheets = [sheet];
    bar = document.createElement("div");
    bar.className = "bar";
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "cdpHelper";
    const instanceBadge = document.createElement("span");
    instanceBadge.className = "instance-number";
    instanceBadge.textContent = `编号 ${displayNumber}`;
    instanceBadge.style.backgroundColor = appearance.background;
    instanceBadge.style.color = appearance.foreground;
    label = document.createElement("span");
    label.className = "action";
    const stop = document.createElement("button");
    stop.className = "stop";
    stop.type = "button";
    stop.textContent = "停止控制";
    stop.addEventListener("click", (event) => {
      if (!event.isTrusted || disposed || Date.now() >= lease) return;
      event.preventDefault();
      event.stopPropagation();
      const notify = globalThis[binding];
      remove();
      if (typeof notify === "function") notify(JSON.stringify({ token, generation, action: "stop" }));
    });
    bar.append(brand);
    if (displayNumber !== null) bar.append(instanceBadge);
    bar.append(label, stop);
    target = document.createElement("div");
    target.className = "target";
    pointer = document.createElement("div");
    pointer.className = "pointer";
    shadow.append(target, pointer, bar);
    document.documentElement.append(host);
    observer.observe(document.documentElement, { childList: true });
    paint();
  };
  const move = (event) => {
    if (!event.isTrusted || !pointer || disposed || !/点击|填写|按键|click|fill|press/i.test(currentAction || ""))
      return;
    Object.assign(pointer.style, { display: "block", left: `${event.clientX}px`, top: `${event.clientY}px` });
  };
  const click = (event) => {
    if (!event.isTrusted || !shadow || disposed || !/点击|填写|按键|click|fill|press/i.test(currentAction || ""))
      return;
    move(event);
    const ripple = document.createElement("div");
    ripple.className = "ripple";
    Object.assign(ripple.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
    shadow.append(ripple);
    ripples.add(ripple);
    const animation = ripple.animate(
      [
        { transform: "scale(.5)", opacity: 1 },
        { transform: "scale(2)", opacity: 0 },
      ],
      { duration: 500 },
    );
    animation.finished
      .catch(() => {})
      .finally(() => {
        ripple.remove();
        ripples.delete(ripple);
      });
  };
  const hide = () => {
    if (pointer) pointer.style.display = "none";
    for (const ripple of ripples) ripple.remove();
    ripples.clear();
  };
  const visibility = () => {
    hide();
    if (Date.now() >= lease) remove();
    else mount();
  };
  const state = {
    refresh(value) {
      if (disposed) return;
      lease = value.expiresAt;
      currentAction = value.action;
      currentBox = value.box;
      mount();
      paint();
      return Boolean(host?.isConnected);
    },
    remove,
  };
  globalThis[key] = state;
  document.addEventListener("mousemove", move, true);
  document.addEventListener("click", click, true);
  window.addEventListener("pagehide", hide);
  document.addEventListener("visibilitychange", visibility);
  observer = new MutationObserver(() => {
    if (Date.now() >= lease) remove();
    else mount();
  });
  observer.observe(document, { childList: true });
  const watchdog = setInterval(() => {
    if (Date.now() >= lease) remove();
    else mount();
  }, 1000);
  mount();
  return Boolean(host?.isConnected);
}

export class PageControl {
  static async create(page, { generation, onStop, displayNumber }) {
    const control = new PageControl(page, { generation, onStop, displayNumber });
    try {
      control.session = await page.context().newCDPSession(page);
      await control.init();
      return control;
    } catch (error) {
      await control.dispose();
      throw error;
    }
  }

  constructor(page, { generation, onStop, displayNumber }) {
    this.page = page;
    this.generation = String(generation);
    this.onStop = onStop;
    this.displayNumber = Number.isSafeInteger(displayNumber) && displayNumber > 0 ? displayNumber : null;
    const nonce = randomBytes(20).toString("hex");
    this.key = `__cdphelper_control_${nonce}`;
    this.world = `cdphelper-control-${nonce}`;
    this.binding = `__cdphelper_stop_${nonce}`;
    this.token = randomBytes(24).toString("hex");
    this.contextId = null;
    this.contextIds = new Set();
    this.disposed = false;
    this.stopped = false;
    this.action = null;
    this.box = null;
    this.pending = Promise.resolve();
  }

  source() {
    return `(${installControl.toString()})(${JSON.stringify({ key: this.key, binding: this.binding, token: this.token, generation: this.generation, expiresAt: Date.now() + TTL, action: this.action, box: this.box, displayNumber: this.displayNumber, appearance: instanceAppearance(this.displayNumber) })})`;
  }

  async init() {
    this.bindingListener = (event) => {
      if (this.disposed || this.stopped || event.name !== this.binding || event.executionContextId !== this.contextId)
        return;
      let payload;
      try {
        payload = JSON.parse(event.payload);
      } catch {
        return;
      }
      if (payload.token !== this.token || payload.generation !== this.generation || payload.action !== "stop") return;
      this.stopped = true;
      clearInterval(this.timer);
      // The callback invalidates ownership immediately; never enter the tool queue here.
      try {
        Promise.resolve(this.onStop()).catch(() => {});
      } catch {}
    };
    this.navigationListener = (event) => {
      if (event.frame.parentId || this.disposed || this.stopped) return;
      this.contextId = null;
      this.box = null;
      this.ensure().catch((error) => {
        this.lastError = error;
      });
    };
    this.contextListener = ({ context }) => {
      if (context.name === this.world) this.contextIds.add(context.id);
    };
    this.destroyedListener = ({ executionContextId }) => {
      this.contextIds.delete(executionContextId);
      if (this.contextId === executionContextId) this.contextId = null;
    };
    this.session.on("Runtime.bindingCalled", this.bindingListener);
    this.session.on("Page.frameNavigated", this.navigationListener);
    this.session.on("Runtime.executionContextCreated", this.contextListener);
    this.session.on("Runtime.executionContextDestroyed", this.destroyedListener);
    // Enabling event delivery is additive. Never disable these shared domains on release.
    await this.session.send("Runtime.enable");
    await this.session.send("Page.enable");
    await this.session.send("Runtime.addBinding", { name: this.binding, executionContextName: this.world });
    this.scriptId = (
      await this.session.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source(), worldName: this.world })
    ).identifier;
    await this.ensure();
    this.timer = setInterval(
      () =>
        this.ensure().catch((error) => {
          this.lastError = error;
        }),
      HEARTBEAT,
    );
    this.timer.unref?.();
  }

  ensure() {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.disposed || this.stopped) throw new Error("Page control is no longer active.");
        let failure;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { frameTree } = await this.session.send("Page.getFrameTree");
            const { executionContextId } = await this.session.send("Page.createIsolatedWorld", {
              frameId: frameTree.frame.id,
              worldName: this.world,
            });
            if (this.disposed || this.stopped) throw new Error("Page control is no longer active.");
            this.contextId = executionContextId;
            this.contextIds.add(executionContextId);
            const result = await this.session.send("Runtime.evaluate", {
              expression: this.source(),
              contextId: executionContextId,
              returnByValue: true,
            });
            if (this.disposed || this.stopped) throw new Error("Page control is no longer active.");
            if (result.exceptionDetails || result.result?.value !== true)
              throw new Error("Could not mount page control.");
            this.lastError = null;
            return;
          } catch (error) {
            failure = error;
            if (this.disposed || this.stopped || !/context|frame|navigation/i.test(error.message)) break;
          }
        }
        throw failure;
      });
    this.pending = operation;
    return operation;
  }

  async update({ action, box = null }) {
    this.action = action ? String(action).slice(0, 200) : null;
    this.box =
      box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
        ? { x: box.x, y: box.y, width: box.width, height: box.height }
        : null;
    await this.ensure();
  }

  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    clearInterval(this.timer);
    this.disposal = (async () => {
      if (!this.session) return;
      this.session.off("Runtime.bindingCalled", this.bindingListener);
      this.session.off("Page.frameNavigated", this.navigationListener);
      this.session.off("Runtime.executionContextCreated", this.contextListener);
      this.session.off("Runtime.executionContextDestroyed", this.destroyedListener);
      await this.pending.catch(() => {});
      if (this.scriptId)
        await this.session
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.scriptId })
          .catch(() => {});
      await Promise.all(
        [...this.contextIds].map((contextId) =>
          this.session
            .send("Runtime.evaluate", {
              expression: `globalThis[${JSON.stringify(this.key)}]?.remove()`,
              contextId,
            })
            .catch(() => {}),
        ),
      );
      this.contextIds.clear();
      await this.session.send("Runtime.removeBinding", { name: this.binding }).catch(() => {});
      await this.session.detach().catch(() => {});
    })();
    return this.disposal;
  }
}
