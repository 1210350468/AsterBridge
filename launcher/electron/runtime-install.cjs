const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

function validateRuntimeBundle(runtimeRoot, { version, platform, arch, bundleId }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || !/^[a-f0-9]{64}$/.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)) {
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(manifest)}`,
    );
  }
  const paths = runtimeBundlePaths(runtimeRoot, platform);
  for (const required of [paths.executable, paths.entrypoint, path.join(runtimeRoot, "app", "browser-helper.cjs")]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Runtime bundle file is missing: ${required}`);
    }
  }
  if (platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return paths.runtimeRoot;
}

function removeRuntimeTreeBestEffort(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

function cleanupStalePreviousRuntimes(versionsRoot, destination) {
  const prefix = `${path.basename(destination)}.previous-`;
  let entries = [];
  try {
    entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    removeRuntimeTreeBestEffort(path.join(versionsRoot, entry.name));
  }
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  validateRuntimeBundle(source, identity);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  const expectedIdentity = { ...identity, bundleId: sourceManifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) {
    try {
      const installed = validateRuntimeBundle(destination, expectedIdentity);
      cleanupStalePreviousRuntimes(versionsRoot, destination);
      return installed;
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
    validateRuntimeBundle(temporary, expectedIdentity);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      validateRuntimeBundle(destination, expectedIdentity);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      // A launcher-owned MCP/tunnel child may still have the previous Bun executable open on
      // Windows. The replacement is already verified at this point, so cleanup must not turn a
      // successful runtime refresh into a fatal launcher startup. A later launch retries stale
      // previous-directory cleanup after the old process has released its handles.
      removeRuntimeTreeBestEffort(previous);
      previousMoved = false;
    }
  } finally {
    removeRuntimeTreeBestEffort(temporary);
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return validateRuntimeBundle(destination, expectedIdentity);
}

module.exports = {
  ensurePackagedRuntime,
  validateRuntimeBundle,
};
