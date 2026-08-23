import { readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, resolve, sep } from "node:path";

export interface RoxyBrowserEndpoint {
  profileId: string;
  profileDir: string;
  endpoint: string;
  discoveredAtMs: number;
  openedByAutomation: boolean;
}

export interface RoxyBrowserAutoOpenOptions {
  autoOpen?: boolean;
  apiHost?: string;
  apiKeyFile?: string;
  openTimeoutMs?: number;
}

export function validateRoxyBrowserProfileId(profileId: string): string {
  const normalized = profileId.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(normalized)) {
    throw new Error("RoxyBrowser profile id must contain only letters, numbers, underscores, or hyphens");
  }
  return normalized;
}

export function validateRoxyBrowserApiHost(apiHost: string): string {
  const normalized = apiHost.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("RoxyBrowser API host must be a valid loopback HTTP URL");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new Error("RoxyBrowser API host must use http://127.0.0.1:<port>");
  }
  if (!parsed.port) parsed.port = "50000";
  return parsed.origin;
}

export function roxyBrowserProfileDir(dataDir: string, profileId: string): string {
  const root = resolve(dataDir);
  const id = validateRoxyBrowserProfileId(profileId);
  const profileDir = resolve(root, id);
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedProfile = process.platform === "win32" ? profileDir.toLowerCase() : profileDir;
  if (!normalizedProfile.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("RoxyBrowser profile path escapes the configured data directory");
  }
  return profileDir;
}

export function parseRoxyDevToolsActivePort(contents: string): { port: number; path: string } | undefined {
  const lines = contents
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return undefined;
  const port = Number.parseInt(lines[0]!, 10);
  const path = lines[1]!;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !path.startsWith("/devtools/browser/")) return undefined;
  return { port, path };
}

async function loopbackPortIsOpen(port: number): Promise<boolean> {
  return await new Promise(resolveOpen => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function roxyBrowserApiRequest(
  apiHost: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${validateRoxyBrowserApiHost(apiHost)}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        token: apiKey,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = undefined;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new Error(`RoxyBrowser Local API returned HTTP ${response.status}`);
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const code = record.code;
      if (typeof code === "number" && code !== 0 && code !== 200) {
        const message = typeof record.msg === "string" ? record.msg : typeof record.message === "string" ? record.message : `code ${code}`;
        throw new Error(`RoxyBrowser Local API rejected the request: ${message}`);
      }
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function readRoxyBrowserApiKey(apiKeyFile: string): string {
  if (!isAbsolute(apiKeyFile)) throw new Error("RoxyBrowser API key file must be absolute");
  let apiKey = "";
  try {
    apiKey = readFileSync(apiKeyFile, "utf8").trim();
  } catch {
    throw new Error("RoxyBrowser API key file is missing or unreadable");
  }
  if (apiKey.length < 8 || apiKey.length > 4096) throw new Error("RoxyBrowser API key file is invalid");
  return apiKey;
}

export async function probeRoxyBrowserLocalApi(apiHost: string, apiKeyFile: string): Promise<void> {
  const apiKey = readRoxyBrowserApiKey(apiKeyFile);
  await roxyBrowserApiRequest(validateRoxyBrowserApiHost(apiHost), apiKey, "/health");
}

export async function discoverRoxyBrowserEndpoint(
  profileId: string,
  dataDir: string,
): Promise<RoxyBrowserEndpoint> {
  const id = validateRoxyBrowserProfileId(profileId);
  const profileDir = roxyBrowserProfileDir(dataDir, id);
  const activePortPath = resolve(profileDir, "DevToolsActivePort");
  let parsed: ReturnType<typeof parseRoxyDevToolsActivePort>;
  let discoveredAtMs = 0;
  try {
    parsed = parseRoxyDevToolsActivePort(readFileSync(activePortPath, "utf8"));
    discoveredAtMs = statSync(activePortPath).mtimeMs;
  } catch {
    throw new Error(`RoxyBrowser profile ${id} is not open or has no DevToolsActivePort file`);
  }
  if (!parsed || !await loopbackPortIsOpen(parsed.port)) {
    throw new Error(`RoxyBrowser profile ${id} is not exposing a reachable Chromium CDP endpoint`);
  }
  return {
    profileId: id,
    profileDir,
    endpoint: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
    discoveredAtMs,
    openedByAutomation: false,
  };
}

export async function ensureRoxyBrowserEndpoint(
  profileId: string,
  dataDir: string,
  options: RoxyBrowserAutoOpenOptions = {},
): Promise<RoxyBrowserEndpoint> {
  const id = validateRoxyBrowserProfileId(profileId);
  try {
    return await discoverRoxyBrowserEndpoint(id, dataDir);
  } catch (discoveryError) {
    if (options.autoOpen !== true) {
      throw new Error(
        `RoxyBrowser profile ${id} is not open. Open this profile in RoxyBrowser and retry, `
        + "or enable automatic RoxyBrowser profile startup in Launcher Settings.",
        { cause: discoveryError },
      );
    }
  }

  if (!options.apiHost?.trim() || !options.apiKeyFile?.trim()) {
    throw new Error(
      `RoxyBrowser profile ${id} is closed and automatic startup is enabled, but the Local API host/key is not configured. `
      + "Enable the RoxyBrowser Local API and configure its API key in Launcher Settings.",
    );
  }

  const apiHost = validateRoxyBrowserApiHost(options.apiHost);
  const apiKey = readRoxyBrowserApiKey(options.apiKeyFile);
  try {
    await roxyBrowserApiRequest(apiHost, apiKey, "/health");
    await roxyBrowserApiRequest(apiHost, apiKey, "/browser/open", {
      method: "POST",
      body: JSON.stringify({ dirId: id, args: [] }),
    });
  } catch (error) {
    throw new Error(
      `Could not automatically open RoxyBrowser profile ${id}. `
      + "Make sure RoxyBrowser is running, Local API is enabled, and the configured API key is current. "
      + `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const timeoutMs = options.openTimeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const discovered = await discoverRoxyBrowserEndpoint(id, dataDir);
      return { ...discovered, openedByAutomation: true };
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(
    `RoxyBrowser profile ${id} was opened through the Local API but did not expose a reachable Chromium CDP endpoint within ${timeoutMs}ms.`,
    { cause: lastError },
  );
}
