import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { defaultBrokerEndpoint, providerConfig, type AppConfig } from "../src/config";
import { startServer } from "../src/server";
import { connectTunnel, stopTunnel, waitForTunnelReady } from "../src/tunnel";

function requiredPath(value: string | undefined, label: string): string {
  const path = value?.trim();
  if (!path || !isAbsolute(path) || !existsSync(path)) throw new Error(`${label} is missing or invalid`);
  return path;
}

function productionConfigPath(): string {
  const configured = process.env.ASTERBRIDGE_E2E_CONFIG?.trim();
  if (configured) return requiredPath(resolve(configured), "ASTERBRIDGE_E2E_CONFIG");
  return requiredPath(join(homedir(), ".codex-chatgpt-web", "config.json"), "production config");
}

function integrationRuntimeRoot(): string {
  const configured = process.env.ASTERBRIDGE_E2E_RUNTIME_ROOT?.trim();
  if (!configured) throw new Error("ASTERBRIDGE_E2E_RUNTIME_ROOT is required");
  return requiredPath(resolve(configured), "ASTERBRIDGE_E2E_RUNTIME_ROOT");
}

function e2eRuntimeHome(): string {
  return resolve(process.env.ASTERBRIDGE_E2E_HOME?.trim() || join(tmpdir(), "asterbridge-web-e2e-home"));
}

function e2ePort(): number {
  const port = Number(process.env.ASTERBRIDGE_E2E_PORT?.trim() || "17842");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("ASTERBRIDGE_E2E_PORT must be a valid TCP port");
  return port;
}

function loadIntegrationConfig(): AppConfig {
  const source = JSON.parse(readFileSync(productionConfigPath(), "utf8")) as AppConfig;
  if (source.mode !== "full" || !source.tunnel) throw new Error("Production config must already be Full mode");
  if (!source.roxyBrowserProfileId || !source.roxyBrowserDataDir) {
    throw new Error("Production config does not contain a reusable RoxyBrowser profile");
  }
  const root = integrationRuntimeRoot();
  const runtimeBun = requiredPath(join(root, "runtime", process.platform === "win32" ? "bun.exe" : "bun"), "integration Bun");
  const runtimeEntrypoint = requiredPath(join(root, "app", "cli.js"), "integration runtime entrypoint");
  const { browserHostDescriptorPath: _launcherDescriptor, ...withoutLauncherDescriptor } = source;
  const runtimeHome = e2eRuntimeHome();
  process.env.CODEX_CHATGPT_WEB_HOME = runtimeHome;
  const browserOnly = process.env.ASTERBRIDGE_E2E_BROWSER_ONLY === "1";
  return {
    ...withoutLauncherDescriptor,
    mode: browserOnly ? "browser-only" : source.mode,
    ...(browserOnly ? { tunnel: undefined } : {}),
    port: e2ePort(),
    brokerSocketPath: defaultBrokerEndpoint(runtimeHome),
    browserHost: "managed-chrome",
    turnBrowserHost: "roxybrowser",
    subagentProtocol: source.subagentProtocol ?? "compatibility-v1",
    experimentalBiggerContext: process.env.ASTERBRIDGE_E2E_BIGGER_CONTEXT === "1"
      ? true
      : source.experimentalBiggerContext === true,
    runtimeCommand: [runtimeBun, runtimeEntrypoint],
  };
}

const require = createRequire(import.meta.url);
const { applyNetworkProxyEnvironment } = require("../launcher/electron/network-proxy.cjs") as {
  applyNetworkProxyEnvironment: (options?: { target?: NodeJS.ProcessEnv; baseEnvironment?: NodeJS.ProcessEnv }) => {
    source: string;
    display: string;
  };
};
const proxy = applyNetworkProxyEnvironment({ target: process.env, baseEnvironment: { ...process.env } });
process.stdout.write(`${JSON.stringify({ event: "ASTERBRIDGE_E2E_PROXY_READY", source: proxy.source, display: proxy.display })}\n`);

const config = loadIntegrationConfig();
if (process.env.ASTERBRIDGE_E2E_BROWSER_CHECK_ONLY === "1" || process.env.ASTERBRIDGE_E2E_BROWSER_SMOKE_ONLY === "1") {
  try {
    const worker = ChatGptBrowserWorker.forProvider(providerConfig(config));
    if (process.env.ASTERBRIDGE_E2E_BROWSER_SMOKE_ONLY === "1") {
      const smoke = await worker.smokeTest();
      process.stdout.write(`${JSON.stringify({
        event: "ASTERBRIDGE_BROWSER_SMOKE_OK",
        effort: smoke.effort,
        response: smoke.response,
      })}\n`);
    } else {
      const inspected = await worker.inspectSession(true);
      process.stdout.write(`${JSON.stringify({
        event: "ASTERBRIDGE_BROWSER_PREFLIGHT_OK",
        sol: inspected.solAvailable === true,
        pro: inspected.proAvailable === true,
      })}\n`);
    }
  } finally {
    await closeChatGptBrowserWorkers();
  }
  process.exit(0);
}
const server = startServer(config);
let tunnelConnected = false;
let stopping = false;

async function shutdown(exitCode = 0): Promise<never> {
  if (stopping) process.exit(exitCode);
  stopping = true;
  try {
    if (tunnelConnected) stopTunnel(config);
  } finally {
    server.stop(true);
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => { void shutdown(130); });
process.once("SIGTERM", () => { void shutdown(143); });

try {
  let tunnelHealthy: boolean | null = null;
  let tunnelReady: boolean | null = null;
  if (config.mode === "full") {
    connectTunnel(config);
    tunnelConnected = true;
    const status = await waitForTunnelReady(config);
    if (!status.ok || !status.healthy || !status.ready) {
      throw new Error(`Integration tunnel did not become healthy/ready: ${status.detail}`);
    }
    tunnelHealthy = status.healthy;
    tunnelReady = status.ready;
  }
  process.stdout.write(`${JSON.stringify({
    event: "ASTERBRIDGE_INTEGRATION_READY",
    port: server.port,
    mode: config.mode,
    browserHost: config.turnBrowserHost ?? config.browserHost,
    biggerContext: config.experimentalBiggerContext,
    tunnelHealthy,
    tunnelReady,
  })}\n`);
  await new Promise<void>(() => {});
} catch (error) {
  process.stderr.write(`integration runtime failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
}
