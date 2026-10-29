import { BrowserLauncher, type LauncherConfig, type LaunchedBrowser } from "./BrowserLauncher.js";

class NoneBrowserLauncher extends BrowserLauncher {
  constructor(config: LauncherConfig = {}) {
    super({ ...config, launcher_mode: "none" });
  }

  async launch(_config: LauncherConfig = {}): Promise<LaunchedBrowser> {
    this.launched = { cdp_url: null, close: async () => {} };
    return this.launched;
  }
}

export { NoneBrowserLauncher };
