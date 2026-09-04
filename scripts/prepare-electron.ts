import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { applyNetworkProxyEnvironment } = require("../launcher/electron/network-proxy.cjs") as {
  applyNetworkProxyEnvironment: (options?: {
    mode?: "auto" | "direct" | "custom";
    customUrl?: string;
    target?: NodeJS.ProcessEnv;
    baseEnvironment?: NodeJS.ProcessEnv;
  }) => { source: string; display: string };
};

const root = resolve(import.meta.dir, "..");
const launcherRoot = resolve(root, "launcher");
const electronRoot = resolve(launcherRoot, "node_modules", "electron");
const installScript = resolve(electronRoot, "install.js");

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const attempts = boundedInteger("ASTERBRIDGE_ELECTRON_INSTALL_ATTEMPTS", 2, 1, 5);
const timeoutMs = boundedInteger("ASTERBRIDGE_ELECTRON_INSTALL_TIMEOUT_MS", 180_000, 10_000, 600_000);
const retryDelayMs = boundedInteger("ASTERBRIDGE_ELECTRON_INSTALL_RETRY_DELAY_MS", 3_000, 0, 30_000);

function electronPlatformPath(): string {
  const platform = process.env.ELECTRON_INSTALL_PLATFORM?.trim()
    || process.env.npm_config_platform?.trim()
    || process.platform;
  switch (platform) {
    case "mas":
    case "darwin":
      return resolve("Electron.app", "Contents", "MacOS", "Electron");
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

function installedElectronPath(): string {
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH?.trim();
  const distRoot = override ? resolve(override) : resolve(electronRoot, "dist");
  return resolve(distRoot, electronPlatformPath());
}

if (!existsSync(installScript)) {
  throw new Error("Electron package is not installed; run `bun install --frozen-lockfile` in launcher first");
}

const binaryPath = installedElectronPath();
if (existsSync(binaryPath)) {
  process.stdout.write(`[electron] ready ${binaryPath}\n`);
  process.exit(0);
}

const installEnvironment = { ...process.env };
const proxy = applyNetworkProxyEnvironment({
  mode: "auto",
  target: installEnvironment,
  baseEnvironment: { ...process.env },
});
process.stdout.write(`[electron] network source=${proxy.source} proxy=${proxy.display}\n`);

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  process.stdout.write(`[electron] install attempt ${attempt}/${attempts}\n`);
  const child = Bun.spawn([process.execPath, installScript, "--no"], {
    cwd: launcherRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: installEnvironment,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* already exited */ }
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);

  if (!timedOut && exitCode === 0 && existsSync(binaryPath)) {
    process.stdout.write(`[electron] PASS ${binaryPath}\n`);
    process.exit(0);
  }

  const reason = timedOut
    ? `timed out after ${timeoutMs} ms`
    : exitCode === 0
      ? `completed without producing ${binaryPath}`
      : `exited with code ${exitCode}`;
  if (attempt === attempts) {
    throw new Error(`Electron binary preparation ${reason}`);
  }
  process.stderr.write(`[electron] ${reason}; retrying\n`);
  if (retryDelayMs > 0) await Bun.sleep(retryDelayMs);
}
