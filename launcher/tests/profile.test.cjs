const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveLauncherProfile } = require("../electron/profile.cjs");

test("DEV launcher profile isolates every durable home from production", () => {
  const homeDir = path.resolve("/Users/tester");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(production.kind, "production");
  assert.equal(development.kind, "development");
  assert.notEqual(development.coreHome, production.coreHome);
  assert.notEqual(development.codexHome, production.codexHome);
  assert.notEqual(development.userData, production.userData);
  assert.notEqual(development.browserPartition, production.browserPartition);
  assert.equal(development.userData, path.join(development.coreHome, "launcher"));
  assert.equal(development.codexHome, path.join(development.coreHome, "codex-home"));
});

test("production launcher uses AsterBridge for new state and preserves a legacy state directory during upgrade", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asterbridge-profile-"));
  const homeDir = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  try {
    const fresh = resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
    assert.equal(fresh.displayName, "AsterBridge");
    assert.equal(fresh.userData, path.join(appData, "AsterBridge"));

    const legacyUserData = path.join(appData, "Codex Web GPT");
    fs.mkdirSync(legacyUserData, { recursive: true });
    const legacy = resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
    assert.equal(legacy.userData, legacyUserData);

    fs.mkdirSync(path.join(appData, "AsterBridge"), { recursive: true });
    const branded = resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
    assert.equal(branded.userData, path.join(appData, "AsterBridge"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DEV launcher refuses an explicit home collision with production", () => {
  const homeDir = path.resolve("/Users/tester");
  const shared = path.join(homeDir, "shared");
  assert.throws(() => resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_WEB_GPT_DEV_HOME: shared,
      CODEX_CHATGPT_WEB_HOME: shared,
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  }), /must differ from the production/);
});

test("DEV launcher ignores generic production path overrides", () => {
  const homeDir = path.resolve("/Users/tester");
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "production-core"),
      CODEX_HOME: path.join(homeDir, "production-codex"),
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "production-launcher"),
      CODEX_WEB_GPT_DEV_HOME: path.join(homeDir, "isolated-dev"),
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(development.coreHome, path.join(homeDir, "isolated-dev"));
  assert.equal(development.codexHome, path.join(homeDir, "isolated-dev", "codex-home"));
  assert.equal(development.userData, path.join(homeDir, "isolated-dev", "launcher"));
});
