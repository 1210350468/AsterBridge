const { execFileSync } = require("node:child_process");

const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];

function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error("Proxy address is invalid"); }
  if (!parsed.hostname) throw new Error("Proxy address must include a hostname");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AsterBridge currently supports HTTP or HTTPS proxy URLs");
  }
  return parsed.toString().replace(/\/$/, "");
}

function readWindowsInternetSetting(name) {
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

function windowsProxyEnabled(value) {
  if (!value) return false;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed !== 0;
}

function selectWindowsProxy(proxyServer) {
  const raw = proxyServer?.trim();
  if (!raw) return "";
  if (!raw.includes("=")) return normalizeProxyUrl(raw);
  const entries = new Map();
  for (const segment of raw.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    const protocol = segment.slice(0, separator).trim().toLowerCase();
    const value = segment.slice(separator + 1).trim();
    if (protocol && value) entries.set(protocol, value);
  }
  return normalizeProxyUrl(entries.get("https") || entries.get("http") || "");
}

function inheritedProxy(environment) {
  for (const key of PROXY_KEYS) {
    const value = environment[key]?.trim();
    if (!value) continue;
    try {
      return normalizeProxyUrl(value);
    } catch {
      // Automatic mode is best-effort: ignore unsupported legacy values such as
      // ALL_PROXY=socks5://... and continue searching for an HTTP(S) proxy.
    }
  }
  return "";
}

function systemProxy({ platform = process.platform, readSetting = readWindowsInternetSetting } = {}) {
  if (platform !== "win32") return "";
  if (!windowsProxyEnabled(readSetting("ProxyEnable"))) return "";
  return selectWindowsProxy(readSetting("ProxyServer"));
}

function proxyDisplay(value) {
  if (!value) return "none";
  try {
    const parsed = new URL(value);
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname}${port}`;
  } catch {
    return "configured";
  }
}

function ensureLocalNoProxy(environment) {
  const existing = environment.NO_PROXY || environment.no_proxy || "";
  const entries = existing.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const required of ["127.0.0.1", "localhost", "::1"]) {
    if (!entries.includes(required)) entries.push(required);
  }
  const value = entries.join(",");
  environment.NO_PROXY = value;
  environment.no_proxy = value;
}

function restoreProxyEnvironment(target, base) {
  for (const key of [...PROXY_KEYS, ...NO_PROXY_KEYS]) {
    if (base[key] === undefined) delete target[key];
    else target[key] = base[key];
  }
}

function applyNetworkProxyEnvironment({
  mode = "auto",
  customUrl = "",
  target = process.env,
  baseEnvironment = process.env,
  platform = process.platform,
  readSetting = readWindowsInternetSetting,
} = {}) {
  if (!["auto", "direct", "custom"].includes(mode)) throw new Error("Unknown proxy mode");
  restoreProxyEnvironment(target, baseEnvironment);

  if (mode === "direct") {
    for (const key of PROXY_KEYS) delete target[key];
    ensureLocalNoProxy(target);
    return { mode, source: "direct", proxyUrl: "", display: "Direct connection" };
  }

  let proxyUrl = "";
  let source = "none";
  if (mode === "custom") {
    proxyUrl = normalizeProxyUrl(customUrl);
    if (!proxyUrl) throw new Error("Custom proxy mode requires a proxy address");
    source = "custom";
  } else {
    proxyUrl = inheritedProxy(baseEnvironment);
    if (proxyUrl) source = "environment";
    else {
      proxyUrl = systemProxy({ platform, readSetting });
      if (proxyUrl) source = platform === "win32" ? "windows-system" : "system";
    }
  }

  if (proxyUrl) {
    target.HTTPS_PROXY = proxyUrl;
    target.HTTP_PROXY = proxyUrl;
    target.https_proxy = proxyUrl;
    target.http_proxy = proxyUrl;
    delete target.ALL_PROXY;
    delete target.all_proxy;
  }
  ensureLocalNoProxy(target);
  return { mode, source, proxyUrl, display: proxyDisplay(proxyUrl) };
}

module.exports = {
  PROXY_KEYS,
  applyNetworkProxyEnvironment,
  inheritedProxy,
  normalizeProxyUrl,
  proxyDisplay,
  selectWindowsProxy,
  systemProxy,
};
