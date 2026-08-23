import { execFileSync } from "node:child_process";
import type { NativeFetch } from "./native-passthrough";

const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

type WindowsInternetSettingReader = (name: "ProxyEnable" | "ProxyServer") => string | undefined;

export interface NativeUpstreamProxyOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readWindowsInternetSetting?: WindowsInternetSettingReader;
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function readWindowsInternetSetting(name: "ProxyEnable" | "ProxyServer"): string | undefined {
  try {
    const output = execFileSync(
      "reg.exe",
      ["query", WINDOWS_INTERNET_SETTINGS, "/v", name],
      { encoding: "utf8", windowsHide: true },
    );
    const match = output.match(new RegExp(`^\\s*${name}\\s+REG_(?:DWORD|SZ)\\s+(.+?)\\s*$`, "mi"));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function windowsProxyEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed !== 0;
}

function selectWindowsProxy(proxyServer: string | undefined): string | undefined {
  const raw = proxyServer?.trim();
  if (!raw) return undefined;
  if (!raw.includes("=")) return normalizeProxyUrl(raw);

  const entries = new Map<string, string>();
  for (const segment of raw.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const protocol = segment.slice(0, separator).trim().toLowerCase();
    const value = segment.slice(separator + 1).trim();
    if (protocol && value) entries.set(protocol, value);
  }
  return normalizeProxyUrl(entries.get("https") ?? entries.get("http"));
}

export function resolveNativeUpstreamProxy({
  environment = process.env,
  platform = process.platform,
  readWindowsInternetSetting: registryReader = readWindowsInternetSetting,
}: NativeUpstreamProxyOptions = {}): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const proxy = normalizeProxyUrl(environment[key]);
    if (proxy) return proxy;
  }

  if (platform !== "win32") return undefined;
  if (!windowsProxyEnabled(registryReader("ProxyEnable"))) return undefined;
  return selectWindowsProxy(registryReader("ProxyServer"));
}

export function createNativeUpstreamFetch(
  options: NativeUpstreamProxyOptions = {},
): NativeFetch {
  const proxy = resolveNativeUpstreamProxy(options);
  if (!proxy) return request => fetch(request);
  return request => fetch(request, { proxy });
}

export const nativeUpstreamFetch = createNativeUpstreamFetch();
