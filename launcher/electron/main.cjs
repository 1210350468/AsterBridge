const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
} = require("electron");
const { BrowserHost } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  createLogger,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { ensurePackagedRuntime } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { applyNetworkProxyEnvironment, normalizeProxyUrl } = require("./network-proxy.cjs");
const { DEVELOPMENT_PROFILE, resolveLauncherProfile } = require("./profile.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createUpdateController } = require("./update.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
const LAUNCHER_PROFILE = resolveLauncherProfile({ appData: app.getPath("appData") });
const IS_DEV_PROFILE = LAUNCHER_PROFILE.kind === DEVELOPMENT_PROFILE;
const CORE_HOME = LAUNCHER_PROFILE.coreHome;
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const GITHUB_URL = "https://github.com/1210350468/AsterBridge";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const TROUBLESHOOTING_URL = "https://github.com/1210350468/AsterBridge/blob/main/docs/troubleshooting.md";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL, TROUBLESHOOTING_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.svg");
const PACKAGED_WINDOWS_ICON_PATH = path.join(process.resourcesPath, "icon.ico");
const BASE_PROXY_ENVIRONMENT = { ...process.env };

process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.codexwebgpt.launcher.dev" : "dev.codexwebgpt.launcher");
}
const launcherUserData = LAUNCHER_PROFILE.userData;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let browserHost = null;
let runtimeHost = null;
let browserControl = null;
let runtimeSupervisor = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let updateController = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  const check = async () => {
    const current = stateStore.read();
    if (current.coreSetupComplete !== true
      || (current.codexCatalogVerified === true && current.codexRestartRequired !== true)) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      const liveCatalogVerified = Number.isInteger(health?.successful_model_catalog_requests)
        && health.successful_model_catalog_requests >= 1;
      let installedCatalogVerified = current.codexCatalogVerified === true;
      if (!installedCatalogVerified) {
        const route = await runtimeHost.bridgeStatus("catalog-verification");
        installedCatalogVerified = route.installed === true
          && route.active === true
          && Array.isArray(route.errors)
          && route.errors.length === 0;
      }
      if (!liveCatalogVerified && !installedCatalogVerified) return;
      const state = stateStore.update({
        codexCatalogVerified: true,
        ...(liveCatalogVerified ? { codexRestartRequired: false } : {}),
      });
      logger.info("codex.model_catalog_verified", {
        source: liveCatalogVerified ? "codex-request" : "managed-route",
        requests: health?.successful_model_catalog_requests ?? 0,
        at: health?.last_successful_model_catalog_request_at ?? null,
      });
      send("launcher:state-changed", state);
      if (liveCatalogVerified || state.codexRestartRequired !== true) stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

async function restoreCodexRouteAfterRuntimeFailure({ logger, stateStore }) {
  try {
    const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
    if (!route.installed || route.active) return { restored: false };
    const state = stateStore.update({
      bridgeEnabled: false,
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    logger.warn("bridge.route_restored_after_runtime_failure", {
      changed: route.changed === true,
    });
    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
    return { restored: false, error: message };
  }
}

function applicationIconImage() {
  if (process.platform === "win32" && app.isPackaged && fs.existsSync(PACKAGED_WINDOWS_ICON_PATH)) {
    const icon = nativeImage.createFromPath(PACKAGED_WINDOWS_ICON_PATH);
    if (!icon.isEmpty()) return icon;
  }
  const svg = fs.readFileSync(APP_ICON_PATH, "utf8");
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

async function trayImage() {
  if (process.platform === "darwin") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M3.2 12.9C5.1 8.4 8.8 5.8 15 4.9M3.4 7.4c3.1.9 6 3.3 8.2 7.5" fill="none" stroke="white" stroke-width="1.55" stroke-linecap="round"/><path d="m9 6.2 2.8 2.8L9 11.8 6.2 9 9 6.2Z" fill="white"/><circle cx="3.2" cy="12.9" r="1.05" fill="white"/><circle cx="15" cy="4.9" r=".9" fill="white"/></svg>`;
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    image.setTemplateImage(true);
    return image;
  }

  // Packaged Windows uses the generated multi-resolution ICO directly. This avoids both stale
  // Windows shell icon caches and Electron's unreliable SVG-to-notification-area rasterization.
  if (process.platform === "win32" && app.isPackaged) {
    const image = nativeImage.createFromPath(PACKAGED_WINDOWS_ICON_PATH);
    if (!image.isEmpty()) return image;
  }

  return applicationIconImage().resize({ width: 18, height: 18, quality: "best" });
}

async function createTray(logger) {
  try {
    const image = await trayImage();
    if (!image || image.isEmpty()) throw new Error("tray image is empty");
    tray = new Tray(image);
    tray.setToolTip(LAUNCHER_PROFILE.displayName);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${LAUNCHER_PROFILE.displayName}`, click: () => showMainWindow() },
      { type: "separator" },
      { label: "Quit", click: () => { void requestQuit(); } },
    ]));
    tray.on("click", () => showMainWindow());
    const size = image.getSize();
    logger.info("launcher.tray_ready", {
      platform: process.platform,
      packaged: app.isPackaged,
      width: size.width,
      height: size.height,
    });
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: LAUNCHER_PROFILE.displayName,
    icon: applicationIconImage(),
    show: false,
    backgroundColor: isMac ? "#00000000" : "#111520",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && tray) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function validateLanguage(value) {
  if (value !== "en" && value !== "zh-CN") throw new Error("Language must be en or zh-CN");
  return value;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}

function roxyBrowserOptionsFromState(state) {
  if (state.useRoxyBrowser !== true) return null;
  return {
    profileId: state.roxyBrowserProfileId,
    dataDir: state.roxyBrowserDataDir,
    autoOpen: state.roxyBrowserAutoOpen === true,
    apiHost: state.roxyBrowserApiHost || "http://127.0.0.1:50000",
    executablePath: state.roxyBrowserExecutablePath || "",
  };
}

async function roxyLocalApiHealthy(options) {
  if (!runtimeHost || !options?.apiHost || !runtimeHost.roxyBrowserApiKeyConfigured()) return false;
  let token = "";
  try {
    token = fs.readFileSync(runtimeHost.roxyBrowserApiKeyPath(), "utf8").trim();
  } catch {
    return false;
  }
  if (!token) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${options.apiHost.replace(/\/$/, "")}/health`, {
      headers: { token },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureRoxyBrowserApplication(options, logger) {
  if (!options?.autoOpen || !options.executablePath) return false;
  if (await roxyLocalApiHealthy(options)) return false;
  if (!path.isAbsolute(options.executablePath)) {
    throw new Error("Configured RoxyBrowser executable path must be absolute");
  }
  const executablePath = path.resolve(options.executablePath);
  if (!fs.existsSync(executablePath)) {
    throw new Error("Configured RoxyBrowser executable does not exist");
  }
  const child = spawn(executablePath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  logger.info("browser.roxy_application_started", { executable: path.basename(executablePath) });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await roxyLocalApiHealthy(options)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("RoxyBrowser started, but its Local API did not become ready within 20 seconds");
}

function applyStateNetworkProxy(state, target = process.env) {
  return applyNetworkProxyEnvironment({
    mode: state.networkProxyMode,
    customUrl: state.networkProxyUrl,
    target,
    baseEnvironment: BASE_PROXY_ENVIRONMENT,
  });
}

function refreshNetworkProxyEnvironment(state, logger, reason) {
  const applied = applyStateNetworkProxy(state, process.env);
  logger.info("network.proxy_refreshed", {
    reason,
    mode: state.networkProxyMode,
    source: applied.source,
    proxy: applied.display,
  });
  return applied;
}

function networkProxyStatus(state) {
  const applied = applyStateNetworkProxy(state, {});
  return { source: applied.source, display: applied.display };
}

function synchronizeExternalBrowserState(stateStore) {
  const state = stateStore.read();
  if (IS_DEV_PROFILE || !runtimeHost) return state;
  let runtimeConfig;
  try {
    runtimeConfig = runtimeHost.runtimeConfigSnapshot().config;
  } catch {
    return state;
  }
  const turnHost = runtimeConfig?.turnBrowserHost ?? runtimeConfig?.browserHost;
  const noExplicitExternalDraft = state.useSystemBrowser !== true
    && state.useRoxyBrowser !== true
    && !state.roxyBrowserProfileId;
  if (!noExplicitExternalDraft) return state;
  if (turnHost === "roxybrowser") {
    return stateStore.update({
      useRoxyBrowser: true,
      roxyBrowserProfileId: runtimeConfig.roxyBrowserProfileId || "",
      roxyBrowserDataDir: runtimeConfig.roxyBrowserDataDir || "",
      roxyBrowserAutoOpen: runtimeConfig.roxyBrowserAutoOpen === true,
      roxyBrowserApiHost: runtimeConfig.roxyBrowserApiHost || "http://127.0.0.1:50000",
    });
  }
  if (turnHost === "system-browser") return stateStore.update({ useSystemBrowser: true });
  return state;
}

function registerIpc({ logger, stateStore }) {
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler);
  handle("launcher:snapshot", async () => ({
    profile: LAUNCHER_PROFILE.kind,
    profilePaths: {
      coreHome: CORE_HOME,
      codexHome: LAUNCHER_PROFILE.codexHome,
      userData: launcherUserData,
    },
    state: synchronizeExternalBrowserState(stateStore),
    browser: browserHost?.snapshot() ?? null,
    roxyPreview: browserControl?.roxyPreviewSnapshot() ?? null,
    connectorName: runtimeHost.browserConnectorName(),
    toolTransport: runtimeHost.toolTransport(),
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured() ?? false,
    roxyApiKeyConfigured: runtimeHost?.roxyBrowserApiKeyConfigured() ?? false,
    networkProxy: networkProxyStatus(stateStore.read()),
    logs: logger.recent(),
    urls: { github: GITHUB_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL, troubleshooting: TROUBLESHOOTING_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
  }));

  handle("launcher:set-language", (_event, language) => stateStore.update({ language: validateLanguage(language) }));
  handle("launcher:roxy-take-control", () => browserControl.requestRoxyAction("take-control"));
  handle("launcher:open-social", async (_event, target) => {
    if (target !== "github") throw new Error("Unknown social target");
    await openWebUrl(GITHUB_URL);
    return stateStore.update({ githubOpened: true });
  });
  handle("launcher:complete-onboarding", (_event, language) => {
    const current = stateStore.read();
    if (!current.githubOpened) throw new Error("Open the GitHub page before continuing");
    if (current.autoStart) setAutostart(app, true);
    const next = stateStore.update({ language: validateLanguage(language), onboardingComplete: true });
    logger.info("launcher.onboarding_completed", { language: next.language });
    return next;
  });

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:browser-bounds", (event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds), event.sender.getZoomFactor());
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal());
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  handle("launcher:mcp-verify", async (event) => {
    const operationName = "mcp-verification";
    const activeTraceId = browserHost.activeTraceId;
    logger.info("mcp.verification_requested", {
      activeTraceId,
      launcherFocused: mainWindow?.isFocused() === true,
      rendererFocused: event.sender.isFocused(),
    });
    if (activeTraceId) {
      const report = {
        ok: false,
        checks: [{
          id: "connector",
          status: "error",
          message: "Finish the active Codex task before verifying the ChatGPT connector",
          detail: `Active browser turn: ${activeTraceId}`,
        }],
      };
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message: report.checks[0].message });
      return report;
    }
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = IS_DEV_PROFILE ? await runtimeHost.devDoctor() : await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      const verificationState = stateStore.read();
      if (!IS_DEV_PROFILE && (verificationState.useSystemBrowser === true || verificationState.useRoxyBrowser === true)) {
        await runtimeHost.verifySystemBrowserConnector();
      } else {
        await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      }
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = IS_DEV_PROFILE
        ? "DEV harness and connector verified"
        : "Runtime and connector verified";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: report.checks.map((check) => check.id === "connector"
          ? {
              id: "connector",
              status: "ok",
              message: `ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} is available`,
            }
          : check),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return {
        ...report,
        ok: false,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          { id: "connector", status: "error", message },
        ],
      };
    }
  });

  handle("launcher:doctor", () => IS_DEV_PROFILE ? runtimeHost.devDoctor() : runtimeHost.doctor());
  handle("launcher:cancel-turns", () => {
    if (IS_DEV_PROFILE) throw new Error("DEV chat turns are owned by the repository CLI process");
    return runtimeHost.cancelActiveTurns();
  });
  handle("launcher:bridge-enabled", async (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex bridge route");
    const result = await runtimeHost.setBridgeEnabled(enabled === true);
    const state = stateStore.update({
      bridgeEnabled: result.active,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    if (result.active) startCatalogVerificationMonitor({ logger, stateStore });
    else stopCatalogVerificationMonitor();
    return state;
  });
  handle("launcher:uninstall-integration", async () => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex integration to remove");
    const language = stateStore.read().language;
    const chinese = language === "zh-CN";
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: chinese ? ["取消", "移除"] : ["Cancel", "Remove"],
      defaultId: 0,
      cancelId: 0,
      title: chinese ? "移除 AsterBridge · 星桥" : "Remove AsterBridge",
      message: chinese
        ? "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？"
        : "Remove the ChatGPT Web models from Codex and restore the previous model route?",
      detail: chinese
        ? "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。"
        : "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
    }
    const state = stateStore.update({
      coreSetupComplete: false,
      bridgeEnabled: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:setup-core", async (_event, input) => {
    const setupState = stateStore.read();
    refreshNetworkProxyEnvironment(setupState, logger, "core-setup");
    const useSystemBrowser = !IS_DEV_PROFILE && setupState.useSystemBrowser === true;
    const useRoxyBrowser = !IS_DEV_PROFILE && setupState.useRoxyBrowser === true;
    const externalBrowser = useSystemBrowser || useRoxyBrowser;
    if (!externalBrowser) {
      const browser = await browserHost.probeAuthentication();
      if (!browser.authenticated) {
        throw new Error(
          IS_DEV_PROFILE
            ? "Sign in to the isolated DEV ChatGPT profile before configuring the harness"
            : "Sign in to ChatGPT before installing the Codex integration",
        );
      }
      if (!setupState.coreSetupComplete
        && !(smokePassedThisSession || smokePassedForCurrentVersion(setupState))) {
        throw new Error(
          IS_DEV_PROFILE
            ? "Run the browser smoke test before configuring the DEV harness"
            : "Run the browser smoke test before installing the Codex integration",
        );
      }
    }
    if (!IS_DEV_PROFILE && useRoxyBrowser) {
      await ensureRoxyBrowserApplication(roxyBrowserOptionsFromState(setupState), logger);
    }
    const result = IS_DEV_PROFILE
      ? await runtimeHost.setupDevCore()
      : await runtimeHost.setupCore({
          useSystemBrowser,
          roxyBrowser: useRoxyBrowser ? roxyBrowserOptionsFromState(setupState) : null,
          fullResponses: input?.fullResponses === true,
        });
    stateStore.update({
      bridgeEnabled: IS_DEV_PROFILE ? false : true,
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
      ...(result.mode === "full" && result.toolTransport === "mcp" ? {
        mcpRuntimeInstalled: true,
        mcpSetupComplete: false,
        mcpGuideStep: 2,
      } : {
        mcpSetupComplete: false,
        mcpRuntimeInstalled: false,
        mcpGuideStep: 0,
      }),
    });
    await browserHost.returnToIdle().catch((error) => {
      logger.warn("browser.idle_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout, restartRequired: !IS_DEV_PROFILE };
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    const browserModeState = stateStore.read();
    refreshNetworkProxyEnvironment(browserModeState, logger, "mcp-setup");
    if (IS_DEV_PROFILE || (!browserModeState.useSystemBrowser && !browserModeState.useRoxyBrowser)) {
      await browserHost.reveal();
    }
    if (!IS_DEV_PROFILE && browserModeState.useRoxyBrowser === true) {
      await ensureRoxyBrowserApplication(roxyBrowserOptionsFromState(browserModeState), logger);
    }
    const setup = IS_DEV_PROFILE
      ? runtimeHost.setupDevMcp.bind(runtimeHost)
      : runtimeHost.setupMcp.bind(runtimeHost);
    const result = await setup({
      tunnelId: typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
      replace: input?.replace === true,
      ...(!IS_DEV_PROFILE ? {
        connectorName: typeof input?.connectorName === "string" ? input.connectorName.trim() : "",
        useSystemBrowser: stateStore.read().useSystemBrowser === true,
        roxyBrowser: roxyBrowserOptionsFromState(stateStore.read()),
      } : {}),
    });
    stateStore.update({
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("The isolated DEV launcher is started explicitly from the repository CLI");
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: stateStore.update({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:bigger-context", async (_event, enabled) => {
    const result = await runtimeHost.setBiggerContext(enabled === true);
    const state = stateStore.update({
      experimentalBiggerContext: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:set-preference", (_event, key, value) => {
    if (key !== "keepRunningOnClose" && key !== "showBrowserDuringTurns" && key !== "useSystemBrowser") {
      throw new Error("Unknown preference");
    }
    const enabled = value === true;
    if (key === "useSystemBrowser") {
      const current = stateStore.read();
      if (current.useSystemBrowser === enabled && (!enabled || current.useRoxyBrowser !== true)) return current;
      stopCatalogVerificationMonitor();
      return stateStore.update({
        useSystemBrowser: enabled,
        ...(enabled ? { useRoxyBrowser: false } : {}),
        coreSetupComplete: false,
        codexCatalogVerified: false,
        codexRestartRequired: true,
      });
    }
    return stateStore.update({ [key]: enabled });
  });
  handle("launcher:set-network-proxy", async (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("Proxy configuration is required");
    const mode = typeof input.mode === "string" ? input.mode : "";
    if (!["auto", "direct", "custom"].includes(mode)) throw new Error("Proxy mode must be auto, direct, or custom");
    const url = mode === "custom" ? normalizeProxyUrl(input.url) : "";
    if (mode === "custom" && !url) throw new Error("Custom proxy mode requires a proxy address");
    if (mode === "custom") {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        throw new Error("Authenticated proxies are not stored in Launcher settings; configure them with HTTPS_PROXY/HTTP_PROXY instead");
      }
    }

    const nextState = stateStore.update({ networkProxyMode: mode, networkProxyUrl: url });
    const applied = applyNetworkProxyEnvironment({
      mode,
      customUrl: url,
      target: process.env,
      baseEnvironment: BASE_PROXY_ENVIRONMENT,
    });
    logger.info("network.proxy_configured", { mode, source: applied.source, proxy: applied.display });

    let runtimeRestarted = false;
    let restartRequired = false;
    try {
      const configured = runtimeHost?.runtimeConfigSnapshot().configured === true;
      if (configured && runtimeSupervisor) {
        await runtimeSupervisor.restart();
        runtimeRestarted = true;
      }
    } catch (error) {
      restartRequired = true;
      logger.warn("network.proxy_runtime_restart_deferred", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    send("launcher:state-changed", nextState);
    return {
      state: nextState,
      source: applied.source,
      display: applied.display,
      runtimeRestarted,
      restartRequired,
    };
  });

  handle("launcher:set-roxy-browser-config", (_event, input) => {
    if (IS_DEV_PROFILE) throw new Error("RoxyBrowser turn hosting is unavailable in the isolated DEV launcher");
    if (!input || typeof input !== "object") throw new Error("RoxyBrowser configuration is required");
    const enabled = input.enabled === true;
    const profileId = typeof input.profileId === "string" ? input.profileId.trim() : "";
    const dataDir = typeof input.dataDir === "string" ? input.dataDir.trim() : "";
    const autoOpen = input.autoOpen === true;
    const apiHost = typeof input.apiHost === "string" && input.apiHost.trim()
      ? input.apiHost.trim()
      : "http://127.0.0.1:50000";
    const executablePath = typeof input.executablePath === "string" ? input.executablePath.trim() : "";
    if ((enabled || profileId) && !/^[A-Za-z0-9_-]{8,128}$/.test(profileId)) {
      throw new Error("RoxyBrowser profile/window ID is invalid");
    }
    if (enabled && (!dataDir || !path.isAbsolute(dataDir))) {
      throw new Error("RoxyBrowser data directory must be an absolute path");
    }
    if (executablePath && (!path.isAbsolute(executablePath) || !fs.existsSync(executablePath))) {
      throw new Error("RoxyBrowser executable path must point to an existing absolute file");
    }
    if (autoOpen) {
      let parsed;
      try { parsed = new URL(apiHost); } catch { throw new Error("RoxyBrowser API host is invalid"); }
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
        throw new Error("RoxyBrowser API host must use http://127.0.0.1:<port>");
      }
    }
    if (input.clearApiKey === true) runtimeHost.setRoxyBrowserApiKey("");
    else if (typeof input.apiKey === "string" && input.apiKey.trim()) runtimeHost.setRoxyBrowserApiKey(input.apiKey);
    if (enabled && autoOpen && !runtimeHost.roxyBrowserApiKeyConfigured()) {
      throw new Error("Automatic RoxyBrowser startup requires an API key");
    }
    stopCatalogVerificationMonitor();
    const state = stateStore.update({
      useRoxyBrowser: enabled,
      ...(enabled ? { useSystemBrowser: false } : {}),
      roxyBrowserProfileId: profileId,
      roxyBrowserDataDir: dataDir,
      roxyBrowserAutoOpen: autoOpen,
      roxyBrowserApiHost: apiHost,
      roxyBrowserExecutablePath: executablePath,
      coreSetupComplete: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    return { state, apiKeyConfigured: runtimeHost.roxyBrowserApiKeyConfigured() };
  });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:open-logs", async () => {
    const error = await shell.openPath(path.dirname(logger.filePath));
    if (error) throw new Error(`Could not open the launcher log directory: ${error}`);
    return logger.filePath;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    const launch = await updateController.beginInstall();
    const result = await requestQuit();
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting AsterBridge`);
    }
    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    stopCatalogVerificationMonitor();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

async function start() {
  cdpPort = await findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => showMainWindow());
  await app.whenReady();
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };

  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  const initialProxyState = stateStore.read();
  applyStateNetworkProxy(initialProxyState, process.env);
  if (IS_DEV_PROFILE && !stateStore.read().onboardingComplete) {
    stateStore.update({
      language: stateStore.read().language || "en",
      onboardingComplete: true,
      autoStart: false,
    });
  }
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = IS_DEV_PROFILE ? { supported: false, enabled: false } : getAutostart(app);
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  const startHidden = process.argv.includes("--hidden") && stateStore.read().onboardingComplete;
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
    publishRoxyPreview: (preview) => send("launcher:roxy-preview", preview),
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
  });
  synchronizeExternalBrowserState(stateStore);
  if (!IS_DEV_PROFILE) {
    const startupRoxy = roxyBrowserOptionsFromState(stateStore.read());
    if (startupRoxy?.autoOpen && startupRoxy.executablePath) {
      void ensureRoxyBrowserApplication(startupRoxy, logger).catch((error) => {
        logger.warn("browser.roxy_application_start_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    partition: LAUNCHER_PROFILE.browserPartition,
    profile: LAUNCHER_PROFILE.kind,
    publishState: (state) => send("launcher:browser-state", state),
  });
  await browserHost.ready();
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && !IS_DEV_PROFILE,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  registerIpc({ logger, stateStore });
  const trayAvailable = await createTray(logger);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  if (!launcherSmokeTest) {
    void browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
      trayReady: trayAvailable,
    })}\n`);
    browserHost.destroy();
    await browserControl.close();
    mainWindow.destroy();
    app.quit();
    return;
  }
  if (IS_DEV_PROFILE) {
    let config = null;
    try {
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("dev_profile.config_invalid", { message });
      publishOperation({ name: "dev-profile", status: "failed", message });
    }
    const state = stateStore.update({
      bridgeEnabled: false,
      coreSetupComplete: Boolean(config),
      codexCatalogVerified: Boolean(config),
      mcpRuntimeInstalled: config?.mode === "full",
      ...(config?.mode !== "full" ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
      codexRestartRequired: false,
      autoStart: false,
      experimentalBiggerContext: config?.experimentalBiggerContext === true,
    });
    send("launcher:state-changed", state);
    logger.info("dev_profile.ready", {
      configured: Boolean(config),
      mode: config?.mode || null,
      coreHome: CORE_HOME,
      userData: launcherUserData,
    });
    if (config?.mode === "full") {
      void runtimeSupervisor.startIfConfigured().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("dev_profile.runtime_start_failed", { message });
        const failed = stateStore.update({ mcpSetupComplete: false });
        send("launcher:state-changed", failed);
      });
    }
  } else void (async () => {
    const upgrade = await runtimeHost.upgradeManagedRuntime();
    if (upgrade.updated) {
      const state = stateStore.update({
        bridgeEnabled: upgrade.bridgeEnabled,
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        experimentalBiggerContext: runtimeHost.runtimeConfigSnapshot().config?.experimentalBiggerContext === true,
        ...(upgrade.mode === "full" ? {
          mcpRuntimeInstalled: true,
          mcpSetupComplete: false,
          mcpGuideStep: 2,
        } : {
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        }),
      });
      send("launcher:state-changed", state);
      logger.info("runtime.release_upgraded", {
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        mode: upgrade.mode,
        bridgeEnabled: upgrade.bridgeEnabled,
        connectorMigrated: upgrade.connectorMigrated,
        responsesFallbackRetired: upgrade.responsesFallbackRetired === true,
      });
    }
    const configuredRuntime = runtimeHost.runtimeConfigSnapshot();
    if (configuredRuntime.configured) {
      const enabled = configuredRuntime.config?.experimentalBiggerContext === true;
      if (stateStore.read().experimentalBiggerContext !== enabled) {
        const state = stateStore.update({ experimentalBiggerContext: enabled });
        send("launcher:state-changed", state);
      }
    }
    try {
      const route = await runtimeHost.bridgeStatus();
      if (route.installed) {
        const current = stateStore.read();
        if (current.bridgeEnabled !== route.active) {
          const state = stateStore.update({ bridgeEnabled: route.active });
          send("launcher:state-changed", state);
        }
        if (!route.active) return { status: "bridge-disabled" };
      }
    } catch (error) {
      logger.warn("bridge.route_status_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return runtimeSupervisor.startIfConfigured();
  })().then(async (runtime) => {
    const synchronizedBrowserState = synchronizeExternalBrowserState(stateStore);
    send("launcher:state-changed", synchronizedBrowserState);
    if (runtime.status === "bridge-disabled") {
      stopCatalogVerificationMonitor();
      return;
    }
    if (runtime.status === "ready") {
      const config = runtimeSupervisor.readConfig();
      let catalogRefreshed = false;
      try {
        const route = await runtimeHost.bridgeStatus("startup-catalog-refresh");
        if (route.installed && route.active) {
          const refreshed = await runtimeHost.setBridgeEnabled(true);
          catalogRefreshed = refreshed.changed === true;
          if (catalogRefreshed) {
            logger.info("codex.model_catalog_refreshed", { source: "launcher-startup" });
          }
        }
      } catch (error) {
        // The existing verified route/runtime remain usable if a best-effort freshness probe fails.
        // Surface the failure in diagnostics without taking an active bridge offline.
        logger.warn("codex.model_catalog_refresh_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const current = stateStore.read();
      const patch = {
        mcpRuntimeInstalled: config.mode === "full",
        experimentalBiggerContext: config.experimentalBiggerContext === true,
        ...(catalogRefreshed ? {
          codexCatalogVerified: false,
          codexRestartRequired: true,
        } : {}),
        ...(config.mode === "browser-only" ? {
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        } : {}),
      };
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        const state = stateStore.update(patch);
        send("launcher:state-changed", state);
      }
      startCatalogVerificationMonitor({ logger, stateStore });
      return;
    }
    if (runtime.status === "not-configured") {
      const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
      const current = stateStore.read();
      if (current.coreSetupComplete || current.mcpRuntimeInstalled || current.mcpSetupComplete) {
        const state = stateStore.update({
          coreSetupComplete: false,
          codexCatalogVerified: false,
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        });
        send("launcher:state-changed", state);
      }
      if (routeRecovery.error) {
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: `Local runtime is not configured; restoring the previous Codex route also failed: ${routeRecovery.error}`,
        });
      }
      return;
    }
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    if (runtime.status === "external" || runtime.status === "needs-setup") {
      const detail = runtime.detail || (
        runtime.status === "external"
          ? "Another process owns the configured AsterBridge runtime"
          : "The installed runtime configuration must be repaired from Setup"
      );
      publishOperation({
        name: "runtime-start",
        status: "failed",
        message: routeRecovery.error
          ? `${detail}; restoring the previous Codex route also failed: ${routeRecovery.error}`
          : routeRecovery.restored
            ? `${detail}; the previous Codex route was restored, restart Codex once`
            : detail,
      });
    }
  }).catch(async (error) => {
    const primary = error instanceof Error ? error.message : String(error);
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const message = routeRecovery.error
      ? `${primary}; restoring the previous Codex route also failed: ${routeRecovery.error}`
      : routeRecovery.restored
        ? `${primary}; the previous Codex route was restored, restart Codex once`
        : primary;
    logger.error("runtime.startup_failed", { message });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    publishOperation({ name: "runtime-start", status: "failed", message });
  });

  app.on("activate", () => showMainWindow());
  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    dialog.showErrorBox("AsterBridge could not start", message);
  } catch {}
  app.exit(1);
});
