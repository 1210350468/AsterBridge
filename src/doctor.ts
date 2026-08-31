import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { AppConfig } from "./config";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { join } from "node:path";
import { inspectCodexIntegration } from "./codex-integration";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { processRunning } from "./process";
import { discoverRoxyBrowserEndpoint, probeRoxyBrowserLocalApi } from "./roxy-browser-host";
import { nativeUpstreamFetch } from "./native-upstream-fetch";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

export function launcherBrowserRequiredForTurns(
  config: Pick<AppConfig, "browserHost" | "turnBrowserHost">,
): boolean {
  return (config.turnBrowserHost ?? config.browserHost) === "launcher";
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

function launcherOwnershipError(config: AppConfig, health: Record<string, unknown>): string | undefined {
  if (config.browserHost !== "launcher") return undefined;
  const path = join(getConfigDir(), "runtime", "launcher-supervisor.json");
  if (!existsSync(path)) return `Launcher runtime ownership marker is missing: ${path}`;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `Launcher runtime ownership marker is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (state.version !== 1
    || !Number.isInteger(state.ownerPid)
    || (state.ownerPid as number) < 1
    || !Number.isInteger(state.daemonPid)
    || (state.daemonPid as number) < 1
    || state.status !== "ready") {
    return "Launcher runtime ownership marker is incomplete or not ready";
  }
  if (!processRunning(state.ownerPid)) {
    return `Launcher owner process is not running (pid ${String(state.ownerPid)})`;
  }
  if (health.pid !== state.daemonPid) {
    return `Responses proxy pid ${String(health.pid)} does not match launcher-owned pid ${String(state.daemonPid)}`;
  }
  return undefined;
}

async function probeTunnelRuntimeHealth(config: AppConfig): Promise<DoctorCheck> {
  const alias = config.tunnel!.alias;
  const stateRoot = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  const healthUrlFile = join(stateRoot, "tunnel-client", "health", `${alias}.url`);
  if (existsSync(healthUrlFile)) {
    try {
      const base = new URL(readFileSync(healthUrlFile, "utf8").trim());
      const loopback = base.protocol === "http:"
        && (base.hostname === "127.0.0.1" || base.hostname === "localhost" || base.hostname === "[::1]");
      if (loopback) {
        const probe = async (pathname: string) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2_000);
          try {
            return await fetch(new URL(pathname, base), { signal: controller.signal });
          } finally {
            clearTimeout(timeout);
          }
        };
        const [healthz, readyz] = await Promise.all([probe("/healthz"), probe("/readyz")]);
        if (healthz.ok && readyz.ok) {
          return { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" };
        }
        return {
          id: "tunnel-runtime",
          status: "error",
          message: "Tunnel runtime is not ready",
          detail: `/healthz=${healthz.status}; /readyz=${readyz.status}`,
        };
      }
    } catch {
      // Fall back to the tunnel-client status command when the local health endpoint is stale or malformed.
    }
  }
  const runtime = tunnelStatus(config);
  return runtime.ok
    ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
    : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail };
}

async function upstreamNetworkCheck(id: string, url: string, label: string): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await nativeUpstreamFetch(new Request(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "user-agent": "AsterBridge doctor" },
    }));
    if (response.status >= 500) {
      return { id, status: "warning", message: `${label} is reachable but returned HTTP ${response.status}` };
    }
    return { id, status: "ok", message: `${label} is reachable (HTTP ${response.status})` };
  } catch (error) {
    return {
      id,
      status: "error",
      message: `${label} is not reachable through the current proxy/network settings`,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function generatedImagesStorageCheck(
  root = join(homedir(), ".codex", "generated_images"),
  maxFiles = 20_000,
): DoctorCheck {
  if (!existsSync(root)) {
    return { id: "generated-images", status: "ok", message: "Generated image storage is empty" };
  }
  const directories = [root];
  let files = 0;
  let bytes = 0;
  let truncated = false;
  try {
    while (directories.length > 0 && !truncated) {
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        files += 1;
        bytes += statSync(path).size;
        if (files >= maxFiles) {
          truncated = true;
          break;
        }
      }
    }
  } catch (error) {
    return {
      id: "generated-images",
      status: "warning",
      message: "Generated image storage could not be measured completely",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const measured = `${files.toLocaleString("en-US")} files / ${formatStorageBytes(bytes)}`;
  return truncated
    ? {
        id: "generated-images",
        status: "warning",
        message: `Generated image storage exceeds the bounded diagnostic scan (${measured} measured)`,
        detail: `Files remain under ${root}; AsterBridge never deletes generated image assets automatically.`,
      }
    : {
        id: "generated-images",
        status: "ok",
        message: `Generated image storage: ${measured}`,
        detail: `Assets remain under ${root}; AsterBridge does not delete them automatically.`,
      };
}

async function proxyCheck(config: AppConfig): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web" || body.status !== "ok") {
      return { id: "proxy", status: "error", message: "The configured port belongs to another service" };
    }
    if (body.mode !== config.mode) {
      return { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` };
    }
    if (body.version !== config.releaseVersion) {
      return { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` };
    }
    if (body.accepting_turns !== true) {
      return {
        id: "proxy",
        status: "error",
        message: "Responses proxy is still drained and is not accepting Codex turns",
      };
    }
    const ownershipError = launcherOwnershipError(config, body);
    if (ownershipError) {
      return { id: "proxy", status: "error", message: "Responses proxy ownership could not be verified", detail: ownershipError };
    }
    return { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: "proxy", status: "error", message: "Responses proxy is not reachable", detail };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  const turnBrowserHost = config.turnBrowserHost ?? config.browserHost;
  if (config.browserHost === "launcher") {
    if (!launcherBrowserRequiredForTurns(config)) {
      checks.push({
        id: "browser-host",
        status: "ok",
        message: `Embedded launcher browser is optional while ${turnBrowserHost} owns ChatGPT turns`,
      });
    } else {
      try {
        const descriptor = readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
        await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, { timeoutMs: 30_000 });
        checks.push({
          id: "browser-host",
          status: "ok",
          message: `Embedded launcher browser is authenticated and reachable (pid ${descriptor.pid})`,
        });
      } catch (error) {
        checks.push({
          id: "browser-host",
          status: "error",
          message: "Embedded launcher browser is unavailable",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else {
    if (!existsSync(config.chromeExecutablePath)) {
      checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
    } else {
      checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
    }
    if (!browserLoginStateExists(config)) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login state is missing or unverified; run `codex-chatgpt-web login`" });
    } else if (!secureFile(config.storageStatePath)) {
      checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}` });
    } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
    } else {
      checks.push({ id: "login", status: "ok", message: "ChatGPT login state has authenticated browser evidence" });
    }
  }

  if (turnBrowserHost === "roxybrowser") {
    try {
      const endpoint = await discoverRoxyBrowserEndpoint(config.roxyBrowserProfileId!, config.roxyBrowserDataDir!);
      checks.push({
        id: "roxy-browser",
        status: "ok",
        message: `RoxyBrowser profile is open and reachable (${endpoint.profileId})`,
      });
    } catch (profileError) {
      if (config.roxyBrowserAutoOpen === true) {
        if (!config.roxyBrowserApiHost || !config.roxyBrowserApiKeyFile || !existsSync(config.roxyBrowserApiKeyFile)) {
          checks.push({
            id: "roxy-browser",
            status: "error",
            message: "RoxyBrowser profile is closed and automatic startup is not fully configured",
            detail: "Save a loopback Local API host and API key in Launcher Settings, or open the configured RoxyBrowser profile manually.",
          });
        } else {
          try {
            await probeRoxyBrowserLocalApi(config.roxyBrowserApiHost, config.roxyBrowserApiKeyFile);
            checks.push({
              id: "roxy-browser",
              status: "ok",
              message: "RoxyBrowser Local API is healthy; the configured profile will auto-open on the next turn",
            });
          } catch (apiError) {
            checks.push({
              id: "roxy-browser",
              status: "error",
              message: "RoxyBrowser profile is closed and Local API auto-start is unavailable",
              detail: apiError instanceof Error ? apiError.message : String(apiError),
            });
          }
        }
      } else {
        checks.push({
          id: "roxy-browser",
          status: "error",
          message: "RoxyBrowser profile is closed",
          detail: "Open the configured RoxyBrowser profile, or enable automatic profile startup in Launcher Settings.",
        });
      }
    }
  }

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({ id: "codex", status: "error", message: "Codex model route is not installed" });
  } else if (codex.errors.length > 0) {
    checks.push({ id: "codex", status: "error", message: "Codex integration is inconsistent", detail: codex.errors.join("; ") });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Codex native model route is installed" });
  }

  const service = getServiceStatus();
  if (config.browserHost === "launcher") {
    checks.push(service.installed || service.loaded
      ? {
          id: "service",
          status: "warning",
          message: "A legacy OS background service still exists; rerun launcher setup to migrate ownership",
          detail: JSON.stringify(service),
        }
      : { id: "service", status: "ok", message: "Launcher owns the background runtime" });
  } else if (!service.supported) {
    checks.push({ id: "service", status: "warning", message: "Managed service is unavailable on this OS; keep `serve` running manually" });
  } else if (!service.installed || !service.loaded) {
    checks.push({ id: "service", status: "error", message: "macOS background service is not installed and loaded" });
  } else {
    checks.push({ id: "service", status: "ok", message: "macOS background service is loaded" });
  }
  checks.push(await proxyCheck(config));
  checks.push(await upstreamNetworkCheck(
    "network-chatgpt",
    "https://chatgpt.com/backend-api/codex/models",
    "ChatGPT/Codex upstream",
  ));
  checks.push(await upstreamNetworkCheck(
    "network-image",
    "https://chatgpt.com/backend-api/codex/images/generations",
    "Codex image backend route",
  ));
  checks.push(generatedImagesStorageCheck());

  if (config.mode === "full") {
    checks.push(await upstreamNetworkCheck(
      "network-openai",
      "https://api.openai.com/v1/models",
      "OpenAI API/tunnel control plane",
    ));
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      checks.push({ id: "tunnel-binary", status: "ok", message: "Pinned openai/tunnel-client binary is installed" });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    if (config.browserHost === "launcher") {
      checks.push(tunnelService.installed || tunnelService.loaded
        ? {
            id: "tunnel-service",
            status: "warning",
            message: "A legacy OS tunnel service still exists; rerun launcher MCP setup to migrate ownership",
            detail: JSON.stringify(tunnelService),
          }
        : { id: "tunnel-service", status: "ok", message: "Launcher owns the tunnel runtime" });
    } else {
      checks.push(tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "macOS tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "macOS tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    }
    checks.push(await probeTunnelRuntimeHealth(config));
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "Browser-only mode intentionally has no local tools or MCP tunnel" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
