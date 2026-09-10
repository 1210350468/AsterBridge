const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");
const runtimeSource = fs.readFileSync(path.join(launcherRoot, "electron", "runtime.cjs"), "utf8");

test("onboarding no longer depends on the removed X/Twitter action", () => {
  assert.doesNotMatch(appSource, /xOpened/);
  assert.doesNotMatch(electronMain, /X_URL|target === "x"|GitHub and X/);
  assert.match(appSource, /disabled=\{busy \|\| \(!isLanguage && !snapshot\.state\.githubOpened\)\}/);
  assert.match(electronMain, /if \(!current\.githubOpened\) throw new Error\("Open the GitHub page before continuing"\)/);
});

test("core and MCP setup refresh the current proxy before spawning runtime commands", () => {
  assert.match(electronMain, /refreshNetworkProxyEnvironment\(setupState, logger, "core-setup"\)/);
  assert.match(electronMain, /refreshNetworkProxyEnvironment\(browserModeState, logger, "mcp-setup"\)/);
});

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("renderer zoom scales the shell without moving or zooming the native ChatGPT surface", () => {
  assert.match(
    electronMain,
    /browserHost\?\.setBounds\(validateBounds\(bounds\), event\.sender\.getZoomFactor\(\)\)/,
  );
  assert.match(browserHostSource, /this\.bindShellZoomShortcuts\(this\.window\.webContents\)/);
  assert.match(browserHostSource, /contents\.setZoomLevel\(next\)/);
  assert.match(appSource, /api!\.zoomBrowser\(action\)/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("Windows tray, window, and renderer brand consume one canonical AsterBridge icon design", () => {
  assert.match(electronMain, /const PACKAGED_WINDOWS_ICON_PATH = path\.join\(process\.resourcesPath, "icon\.ico"\)/);
  assert.match(electronMain, /nativeImage\.createFromPath\(PACKAGED_WINDOWS_ICON_PATH\)/);
  assert.doesNotMatch(electronMain, /app\.getFileIcon\(process\.execPath/);
  assert.doesNotMatch(electronMain, /DEV_TRAY_ICON_PATH/);
  assert.match(appSource, /const BRAND_ICON_URL = new URL\("\.\.\/assets\/icon\.svg", import\.meta\.url\)\.href/);
  assert.match(appSource, /<img alt="" aria-hidden="true" src=\{BRAND_ICON_URL\} \/>/);
  assert.doesNotMatch(appSource, /M4\.2 15\.2c2\.4-5\.9/);
  assert.match(electronMain, /if \(!image \|\| image\.isEmpty\(\)\) throw new Error\("tray image is empty"\)/);
  assert.match(electronMain, /const trayAvailable = await createTray\(logger\)/);
  assert.match(electronMain, /logger\.info\("launcher\.tray_ready"/);
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  assert.match(
    electronMain,
    /runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/,
  );
  const persist = electronMain.indexOf("await browserHost?.persistSession()");
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("DEV launcher exposes its profile and supervises only its Full-mode MCP runtime", () => {
  assert.match(electronMain, /profile:\s*LAUNCHER_PROFILE\.kind/);
  assert.match(electronMain, /if \(IS_DEV_PROFILE\) \{[\s\S]*?config\?\.mode === "full"[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?\} else void \(async \(\) => \{/);
  assert.match(electronMain, /await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /packaged:\s*app\.isPackaged && !IS_DEV_PROFILE/);
  assert.match(electronMain, /IS_DEV_PROFILE && !stateStore\.read\(\)\.onboardingComplete/);
  assert.match(electronMain, /onboardingComplete:\s*true,[\s\S]*?autoStart:\s*false/);
  assert.match(appSource, /snapshot\.profile === "development"/);
  assert.match(appSource, /data-profile=\{snapshot\.profile\}/);
});

test("the renderer bridge switch reaches the fail-closed runtime route", () => {
  assert.match(appSource, /api!\.setBridgeEnabled\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBridgeEnabled\(enabled === true\)/);
  assert.match(electronMain, /codexRestartRequired:\s*true/);
});

test("Bigger Context setting safely handles active turns before restarting the runtime", () => {
  assert.match(appSource, /<SettingRow body=\{copy\.biggerContextBody\} label=\{copy\.biggerContext\}>/);
  assert.match(appSource, /api!\.setBiggerContext\(enabled\)/);
  assert.match(preloadSource, /launcher:bigger-context/);
  assert.match(electronMain, /runtimeSupervisor\.proxyHealthPayload\(config\)/);
  assert.match(electronMain, /activeHttpTurns > 0 \|\| activeBrowserTurns > 0/);
  assert.match(electronMain, /Cancel turn and switch/);
  assert.match(electronMain, /await runtimeHost\.cancelActiveTurns\(\)/);
  assert.match(electronMain, /runtimeHost\.setBiggerContext\(desired\)/);
  assert.match(electronMain, /experimentalBiggerContext:\s*result\.enabled/);
  assert.match(appSource, /Error invoking remote method '\[\^'\]\+': Error:/);
});

test("image generation provider setting reaches the runtime SSOT and protects active turns", () => {
  assert.match(appSource, /<SettingRow body=\{copy\.imageGenerationProviderBody\} label=\{copy\.imageGenerationProvider\}>/);
  assert.match(appSource, /api!\.setImageGenerationProvider\(provider\)/);
  assert.match(appSource, /<option value="auto">\{copy\.imageProviderAuto\}<\/option>/);
  assert.match(appSource, /<option value="codex-tool">\{copy\.imageProviderCodexTool\}<\/option>/);
  assert.match(appSource, /value="web-direct"/);
  assert.match(preloadSource, /launcher:image-generation-provider/);
  assert.match(electronMain, /imageGenerationProvider:\s*runtimeHost\.imageGenerationProvider\(\)/);
  assert.match(electronMain, /handle\("launcher:image-generation-provider"/);
  assert.match(electronMain, /await runtimeHost\.cancelActiveTurns\(\)/);
  assert.match(electronMain, /runtimeHost\.setImageGenerationProvider\(provider\)/);
  assert.match(runtimeSource, /imageGenerationProvider\(\)/);
  assert.match(runtimeSource, /--image-generation-provider/);
  assert.match(runtimeSource, /--restart-service/);
  assert.match(runtimeSource, /Web Direct image generation currently requires RoxyBrowser or the system browser/);
});

test("MCP remains the primary Full Harness path while Responses stays backend-optional", () => {
  assert.match(appSource, /await api!\.setupCore\(\);/);
  assert.doesNotMatch(appSource, /setupCore\(\{ fullResponses: true \}\)/);
  assert.match(appSource, /<SectionHeading label=\{devProfile \? "MCP" : copy\.mcpTitle\} meta=\{devProfile \? copy\.optional : copy\.recommended\}/);
  assert.match(electronMain, /fullResponses:\s*input\?\.fullResponses === true/);
  assert.match(preloadSource, /setupCore:\s*\(input\) => ipcRenderer\.invoke\("launcher:setup-core", input\)/);
});

test("MCP connection remains unavailable until the model catalog is verified", () => {
  assert.match(
    appSource,
    /snapshot\.state\.codexCatalogVerified \? copy\.mcpStepTwoHint : copy\.mcpCatalogRequired/,
  );
  assert.match(appSource, /\|\| !snapshot\.state\.codexCatalogVerified/);
});

test("catalog verification accepts an intact managed route when Codex uses the static model catalog", () => {
  assert.match(electronMain, /const liveCatalogVerified = Number\.isInteger\(health\?\.successful_model_catalog_requests\)/);
  assert.match(electronMain, /await runtimeHost\.bridgeStatus\("catalog-verification"\)/);
  assert.match(electronMain, /route\.installed === true[\s\S]*?route\.active === true[\s\S]*?route\.errors\.length === 0/);
  assert.match(electronMain, /source: liveCatalogVerified \? "codex-request" : "managed-route"/);
  assert.match(electronMain, /liveCatalogVerified \? \{ codexRestartRequired: false \} : \{\}/);
});

test("MCP navigation remains locked while an operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("MCP verification failures stay inside the structured setup report", () => {
  assert.match(appSource, /next\.operation\.name !== "mcp-verification"/);
  assert.match(appSource, /next\.name !== "mcp-verification"/);
  assert.match(electronMain, /Finish the active Codex task before verifying the ChatGPT connector/);
  assert.match(electronMain, /report\.checks\.filter\(\(check\) => check\.id !== "connector"\)/);
  assert.match(electronMain, /mcp\.verification_requested/);
  assert.match(electronMain, /launcherFocused:\s*mainWindow\?\.isFocused\(\) === true/);
  assert.match(electronMain, /rendererFocused:\s*event\.sender\.isFocused\(\)/);
});

test("MCP verification proves runtime health before checking the connector", () => {
  const start = electronMain.indexOf('handle("launcher:mcp-verify"');
  const end = electronMain.indexOf('handle("launcher:doctor"', start);
  const handler = electronMain.slice(start, end);

  assert.ok(start >= 0 && end > start, "MCP verification handler must remain registered");
  assert.match(
    handler,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?if \(!report\.ok\)[\s\S]*?return report;[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  assert.match(handler, /publishOperation\(\{ name: operationName, status: "completed"/);
  assert.match(appSource, /onClick=\{\(\) => void \(doctor\?\.ok \? onDone\(\) : verify\(\)\)\}/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
});

test("saved ChatGPT authentication is refreshed before setup is presented", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe", () => {
  assert.match(appSource, /<SetupRow[\s\S]*?onAction=\{install\}[\s\S]*?repeatable/);
  assert.match(appSource, /complete && !repeatable/);
  assert.match(
    electronMain,
    /!setupState\.coreSetupComplete[\s\S]*?smokePassedThisSession[\s\S]*?smokePassedForCurrentVersion\(setupState\)/,
  );
});

test("session reminders expose dismissal and a real storage-clearing logout", () => {
  assert.match(electronMain, /sessionRefreshReminderAt:\s*nextSessionRefreshReminderAt\(\)/);
  assert.match(electronMain, /launcher:session-reminder-dismiss/);
  assert.match(electronMain, /launcher:browser-logout[\s\S]*?browserHost\.logout\(\)/);
  assert.match(preloadSource, /dismissSessionReminder:[\s\S]*?launcher:session-reminder-dismiss/);
  assert.match(preloadSource, /logoutChatGpt:[\s\S]*?launcher:browser-logout/);
  assert.match(browserHostSource, /session\.clearStorageData\(\)/);
});
