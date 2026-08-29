const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("the public launcher command uses the Electron bootstrap", () => {
  assert.equal(repositoryManifest.scripts.launcher, "bun run scripts/start-launcher.ts");
  assert.equal(repositoryManifest.scripts.launcher, repositoryManifest.scripts.app);
});

test("launcher publishes native packages for all supported desktop operating systems", () => {
  assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");
  assert.equal(manifest.build.artifactName, "asterbridge-${version}-${os}-${arch}.${ext}");
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.equal(manifest.build.productName, "AsterBridge");
  assert.equal(manifest.build.win.icon, "build/icons/icon.ico");
  assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
  assert.ok(manifest.build.files.includes("assets/icon.svg"));
  assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.svg")));
  assert.ok(manifest.build.extraResources.some((entry) => entry.from === "build/icons/icon.ico" && entry.to === "icon.ico"));
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.include, "scripts/installer.nsh");
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.runAfterFinish, true);
  assert.match(manifest.build.nsis.guid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
});

test("Windows installer recovers a stale AsterBridge registration without deleting a live install", () => {
  const recovery = fs.readFileSync(path.join(launcherRoot, "scripts", "installer.nsh"), "utf8");
  assert.match(recovery, /!macro customInit/);
  assert.match(recovery, /AsterBridge\.exe/);
  assert.match(recovery, /Codex Web GPT\.exe/);
  assert.match(recovery, /Uninstall AsterBridge\.exe/);
  assert.match(recovery, /Uninstall Codex Web GPT\.exe/);
  assert.match(recovery, /DeleteRegKey HKCU "\$\{UNINSTALL_REGISTRY_KEY\}"/);
  assert.match(recovery, /DeleteRegKey HKCU "\$\{INSTALL_REGISTRY_KEY\}"/);
  assert.ok(
    recovery.indexOf('IfFileExists "$0\\AsterBridge.exe"') < recovery.indexOf('DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"'),
    "a live installation must be checked before stale registration keys are removed",
  );
});

test("release installers resolve checksummed native launcher assets", () => {
  const shellInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.sh"), "utf8");
  const windowsInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.ps1"), "utf8");
  const devProfile = fs.readFileSync(path.join(repositoryRoot, "src", "dev-chat", "profile.ts"), "utf8");
  const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
  const iconBuilder = fs.readFileSync(path.join(launcherRoot, "scripts", "prepare-win-icon.cjs"), "utf8");
  for (const installer of [shellInstaller, windowsInstaller]) {
    assert.match(installer, /checksums\.txt/);
    assert.match(installer, /SHA-?256/i);
    assert.match(installer, /releases\/download/);
  }
  assert.match(shellInstaller, /PLATFORM="mac"/);
  assert.match(shellInstaller, /PLATFORM="linux"/);
  assert.match(shellInstaller, /codex-web-gpt\.desktop/);
  assert.match(shellInstaller, /--appimage-extract/);
  assert.match(packager, /-linux-x86_64\(\?=\\\.\).*?-linux-x64/);
  assert.match(packager, /const executable = "node"/);
  assert.doesNotMatch(packager, /process\.execPath/);
  assert.match(packager, /electron-builder\/out\/cli\/cli\.js/);
  assert.match(packager, /target === "--mac" && !env\.CSC_LINK && !env\.CSC_NAME/);
  assert.match(packager, /--config\.mac\.identity=-/);
  assert.doesNotMatch(packager, /electron-builder\.cmd/);
  assert.match(packager, /prepare-win-icon\.cjs/);
  assert.match(iconBuilder, /path\.join\(root, "assets", "icon\.svg"\)/);
  assert.match(iconBuilder, /format:\s*"ico"/);
  assert.match(iconBuilder, /path\.join\(root, "build", "icons"\)/);
  assert.match(shellInstaller, /shell_quote\(\)/);
  assert.match(shellInstaller, /exec %s "\$@"/);
  assert.ok(
    shellInstaller.indexOf('chmod 0755 "$TEMP_DIR/$ASSET"')
      < shellInstaller.indexOf('"$TEMP_DIR/$ASSET" --appimage-extract'),
    "the downloaded AppImage must be executable before it is inspected",
  );
  assert.match(windowsInstaller, /asterbridge-\$Version-win-\$Arch\.exe/);
  assert.match(windowsInstaller, /\[Environment\]::Is64BitOperatingSystem/);
  assert.doesNotMatch(windowsInstaller, /RuntimeInformation/);
  assert.ok(windowsInstaller.includes(`HKCU:\\Software\\${manifest.build.nsis.guid}`));
  assert.ok(devProfile.includes(`WINDOWS_LAUNCHER_GUID = "${manifest.build.nsis.guid}"`));
  assert.match(windowsInstaller, /Get-ItemPropertyValue[\s\S]*InstallLocation/);
  assert.ok(windowsInstaller.includes(`Join-Path $InstallLocation "${manifest.build.productName}.exe"`));
  assert.match(windowsInstaller, /-ArgumentList "\/S", "\/currentuser"/);
  const packageSmoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(packageSmoke, /WINDOWS_INSTALL_TIMEOUT_MS = 10 \* 60_000/);
  assert.match(packageSmoke, /run\(installer, \["\/S", "\/currentuser"\], \{ timeout: WINDOWS_INSTALL_TIMEOUT_MS \}\)/);
  assert.match(packageSmoke, /resources[\s\S]*runtime[\s\S]*bun\.exe/);
  assert.match(packageSmoke, /codex-chatgpt-web\.cmd/);
  assert.match(packageSmoke, /marker\.trayReady !== true/);
  assert.match(packageSmoke, /reg\.exe[\s\S]*InstallLocation/);
});

test("packaged launcher owns a detached checksummed updater for every release platform", () => {
  const updater = fs.readFileSync(path.join(launcherRoot, "electron", "update.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(launcherRoot, "electron", "update-worker.cjs"), "utf8");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.match(updater, new RegExp(`platform === "${platform}"`));
    assert.match(worker, new RegExp(`job\\.platform === "${platform}"`));
  }
  assert.match(updater, /expectedChecksum/);
  assert.match(updater, /SHA-256 verification failed/);
  assert.match(updater, /detached:\s*true/);
  assert.match(worker, /waitForParent/);
  assert.doesNotMatch(worker, /backup/i);
});

test("CI packages and smoke-launches on macOS, Windows, and Linux", () => {
  const ci = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(ci, /macos-15, ubuntu-latest, windows-latest/);
  assert.match(ci, /bun run app:package/);
  assert.match(ci, /bun run app:smoke/);
  assert.match(ci, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.0/);
  for (const runner of ["macos-15", "macos-15-intel", "ubuntu-latest", "windows-latest"]) {
    assert.match(release, new RegExp(runner));
  }
  assert.match(release, /launcher\/build\/runtime/);
  assert.match(release, /bun run app:smoke/);
  assert.match(release, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.0/);
  assert.match(release, /codesign --verify --deep --strict --verbose=2/);
  assert.match(release, /AsterBridge\.app/);
  assert.doesNotMatch(release, /gh release create[\s\S]*?--draft/);
});

test("packaged launcher smoke marker records tray readiness", () => {
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  assert.match(main, /runtimeVerified:\s*true/);
  assert.match(main, /trayReady:\s*trayAvailable/);
});

test("macOS package smoke unregisters its staged app from LaunchServices", () => {
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(smoke, /Frameworks\/LaunchServices\.framework\/Support\/lsregister/);
  assert.match(smoke, /\["-u", macAppBundle\]/);
  assert.ok(
    smoke.indexOf('["-u", macAppBundle]') < smoke.indexOf("fs.rmSync(scratch"),
    "the staged app must be unregistered before its bundle is deleted",
  );
});

test("release publishes the repository demo as a checksummed versioned asset", () => {
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  const demo = fs.readFileSync(path.join(repositoryRoot, "assets", "demo.gif"));
  const demoCopy = 'cp assets/demo.gif "release-assets/asterbridge-${GITHUB_REF_NAME#v}-demo.gif"';
  const checksumStep = release.indexOf("- name: Create checksums");
  assert.equal(demo.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.ok(release.includes(demoCopy));
  assert.ok(
    release.indexOf(demoCopy) < checksumStep,
    "the versioned demo must enter release-assets before checksums are generated",
  );
  assert.match(release.slice(checksumStep), /find \. -maxdepth 1 -type f ! -name checksums\.txt/);
});

test("Windows packages embed the checksummed Bun baseline runtime for CPUs without AVX2", () => {
  const builder = fs.readFileSync(path.join(repositoryRoot, "scripts", "build-runtime-bundle.ts"), "utf8");
  const baseline = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "prepare-windows-baseline-bun.ps1"),
    "utf8",
  );
  assert.match(builder, /CODEX_CHATGPT_WEB_EMBEDDED_BUN/);
  assert.match(builder, /Embedded Bun must be/);
  assert.match(baseline, /bun-windows-x64-baseline\.zip/);
  assert.match(baseline, /SHASUMS256\.txt/);
  assert.match(baseline, /Get-FileHash[^\n]+SHA256/);
  assert.match(baseline, /CODEX_CHATGPT_WEB_EMBEDDED_BUN=/);
});
