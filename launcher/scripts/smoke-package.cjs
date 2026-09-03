const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const launcherRoot = path.resolve(__dirname, "..");
const artifactsDirectory = path.join(launcherRoot, "artifacts");
const launcherManifest = JSON.parse(
  fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"),
);
const expectedVersion = launcherManifest.version;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-package-smoke-"));
const markerPath = path.join(scratch, "ready.json");
const coreHome = path.join(scratch, "core-home");
const WINDOWS_INSTALL_TIMEOUT_MS = 10 * 60_000;
const PACKAGED_LAUNCHER_SMOKE_TIMEOUT_MS = 5 * 60_000;
const WINDOWS_INSTALLER_BOOTSTRAP_GRACE_MS = 10_000;
const WINDOWS_INSTALL_POLL_MS = 500;
let macAppBundle;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout || 45_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryWindowsInstallLocation() {
  const guid = launcherManifest.build.nsis.guid;
  const registryKey = `HKCU\\Software\\${guid}`;
  const result = spawnSync("reg.exe", ["query", registryKey, "/v", "InstallLocation"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  const match = result.stdout.match(/^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/mi);
  return match && path.win32.isAbsolute(match[1]) ? match[1] : null;
}

function windowsInstallLocation() {
  const installLocation = tryWindowsInstallLocation();
  if (installLocation) return installLocation;
  const registryKey = `HKCU\\Software\\${launcherManifest.build.nsis.guid}`;
  throw new Error(`Windows installer did not register a valid InstallLocation under ${registryKey}`);
}

function windowsInstallerProcessCount(installer) {
  const quotedInstaller = installer.replace(/'/g, "''");
  const command = `@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq '${quotedInstaller}' }).Count`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect Windows installer process state: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`);
  }
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Windows installer process probe returned an invalid count: ${result.stdout.trim()}`);
  }
  return count;
}

function windowsPackagedRuntimeReady() {
  const installLocation = tryWindowsInstallLocation();
  if (!installLocation) return false;
  const packagedRuntimeRoot = path.join(installLocation, "resources", "runtime");
  const required = [
    path.join(installLocation, `${launcherManifest.build.productName}.exe`),
    path.join(packagedRuntimeRoot, "runtime", "bun.exe"),
    path.join(packagedRuntimeRoot, "bin", "codex-chatgpt-web.cmd"),
    path.join(packagedRuntimeRoot, "manifest.json"),
  ];
  if (!required.every((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packagedRuntimeRoot, "manifest.json"), "utf8"));
    return manifest.appVersion === expectedVersion
      && manifest.platform === process.platform
      && manifest.arch === process.arch
      && /^[a-f0-9]{64}$/.test(manifest.bundleId);
  } catch {
    return false;
  }
}

function installWindowsPackage(installer) {
  const result = spawnSync(installer, ["/S", "/currentuser"], {
    cwd: scratch,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: WINDOWS_INSTALL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;

  const diagnostic = () => result.stderr?.trim() || result.stdout?.trim() || "no output";
  const firstProbeDeadline = Date.now() + WINDOWS_INSTALLER_BOOTSTRAP_GRACE_MS;
  let detachedInstallerObserved = false;
  do {
    if (windowsInstallerProcessCount(installer) > 0) {
      detachedInstallerObserved = true;
      break;
    }
    if (result.status === 0 && windowsPackagedRuntimeReady()) return;
    sleepSync(WINDOWS_INSTALL_POLL_MS);
  } while (Date.now() < firstProbeDeadline);

  // electron-builder's NSIS bootstrap can return a non-zero status while a second installer
  // process continues the same silent installation. Accept that boundary only when the exact
  // installer executable is observed still running; a naked non-zero exit remains a real failure.
  if (!detachedInstallerObserved && result.status !== 0) {
    throw new Error(`${installer} failed with status ${result.status}: ${diagnostic()}`);
  }

  const completionDeadline = Date.now() + WINDOWS_INSTALL_TIMEOUT_MS;
  while (Date.now() < completionDeadline) {
    const running = windowsInstallerProcessCount(installer) > 0;
    if (!running) {
      if (windowsPackagedRuntimeReady()) return;
      throw new Error(
        `Windows installer process exited without completing the ${expectedVersion} packaged runtime; initial status=${String(result.status)}: ${diagnostic()}`,
      );
    }
    sleepSync(WINDOWS_INSTALL_POLL_MS);
  }
  throw new Error(`Windows installer did not settle within ${WINDOWS_INSTALL_TIMEOUT_MS} ms`);
}

function artifact(pattern, label) {
  const matches = fs.readdirSync(artifactsDirectory)
    .filter((name) => pattern.test(name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${artifactsDirectory}; found ${matches.join(", ") || "none"}`);
  }
  return path.join(artifactsDirectory, matches[0]);
}

function smokeEnvironment() {
  return {
    ...process.env,
    TMPDIR: scratch,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(scratch, "launcher-data"),
    CODEX_CHATGPT_WEB_HOME: coreHome,
    CODEX_HOME: path.join(scratch, "codex-home"),
    CODEX_WEB_GPT_SMOKE_FILE: markerPath,
  };
}

try {
  let executable;
  let command;
  let args;
  const env = smokeEnvironment();

  if (process.platform === "darwin") {
    const archive = artifact(/-mac-(?:arm64|x64)\.zip$/, "macOS launcher archive");
    const stage = path.join(scratch, "stage");
    fs.mkdirSync(stage);
    run("ditto", ["-x", "-k", archive, stage]);
    macAppBundle = path.join(stage, "AsterBridge.app");
    executable = path.join(macAppBundle, "Contents", "MacOS", "AsterBridge");
    command = executable;
    args = ["--launcher-smoke-test"];
  } else if (process.platform === "linux") {
    executable = artifact(/-linux-x64\.AppImage$/, "Linux AppImage");
    fs.chmodSync(executable, 0o755);
    command = "xvfb-run";
    args = ["-a", executable, "--launcher-smoke-test"];
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
  } else if (process.platform === "win32") {
    const installer = artifact(/-win-x64\.exe$/, "Windows installer");
    installWindowsPackage(installer);
    const installLocation = windowsInstallLocation();
    executable = path.join(installLocation, `${launcherManifest.build.productName}.exe`);
    const packagedRuntimeRoot = path.join(installLocation, "resources", "runtime");
    for (const required of [
      path.join(packagedRuntimeRoot, "runtime", "bun.exe"),
      path.join(packagedRuntimeRoot, "bin", "codex-chatgpt-web.cmd"),
      path.join(packagedRuntimeRoot, "manifest.json"),
    ]) {
      if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
        throw new Error(`Windows installer completed without required packaged runtime file: ${required}`);
      }
    }
    command = executable;
    args = ["--launcher-smoke-test"];
  } else {
    throw new Error(`Unsupported package smoke platform: ${process.platform}`);
  }

  if (!fs.existsSync(executable)) throw new Error(`Packaged launcher executable is missing: ${executable}`);
  run(command, args, { env, timeout: PACKAGED_LAUNCHER_SMOKE_TIMEOUT_MS });
  if (!fs.existsSync(markerPath)) throw new Error("Packaged launcher did not write its readiness marker");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.ok !== true
    || marker.packaged !== true
    || marker.runtimeVerified !== true
    || (process.platform === "win32" && marker.trayReady !== true)
    || marker.version !== expectedVersion
    || marker.platform !== process.platform) {
    throw new Error(`Unexpected packaged launcher marker: ${JSON.stringify(marker)}`);
  }
  const installedRuntime = path.join(
    coreHome,
    "versions",
    `${expectedVersion}-${process.platform}-${process.arch}`,
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"),
  );
  if (installedManifest.appVersion !== expectedVersion
    || installedManifest.platform !== process.platform
    || installedManifest.arch !== process.arch
    || !/^[a-f0-9]{64}$/.test(installedManifest.bundleId)) {
    throw new Error(`Packaged launcher installed the wrong durable runtime: ${JSON.stringify(installedManifest)}`);
  }
  process.stdout.write(`PACKAGED_LAUNCHER_SMOKE_OK ${process.platform}/${process.arch}\n`);
} finally {
  try {
    if (macAppBundle) {
      const launchServices =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      run(
        launchServices,
        ["-u", macAppBundle],
      );
      run(launchServices, ["-gc"]);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
