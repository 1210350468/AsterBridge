import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexManagedCatalogPath,
  getCodexModelsCachePath,
  installCodexIntegration,
  inspectCodexIntegration,
  preflightCodexIntegration,
  readCodexModelContextOverride,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";
import {
  buildManagedCodexModelCatalog,
  codexBundledCatalogExecutableCandidates,
  supplementMissingModels,
} from "../src/codex-managed-model-catalog";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string; appHome: string } {
  const root = join(tmpdir(), `codex-chatgpt-web-integration-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  const appHome = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  writeFileSync(join(codexHome, "models_cache.json"), `${JSON.stringify({
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Native fixture model",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "medium", description: "Medium" },
        { effort: "high", description: "High" },
        { effort: "xhigh", description: "Extra High" },
      ],
      default_reasoning_level: "high",
      tool_mode: "code_mode_only",
      context_window: 200_000,
      max_context_window: 200_000,
      effective_context_window_percent: 90,
      auto_compact_token_limit: 180_000,
    }],
  }, null, 2)}\n`);
  return { root, codexHome, appHome };
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reversible native Codex route integration", () => {
  test("prefers the current Windows Desktop Codex core before stale PATH fallbacks", () => {
    const desktop = "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\current\\codex.exe";
    const candidates = codexBundledCatalogExecutableCandidates("win32", {}, [desktop]);
    expect(candidates[0]).toBe(desktop);
    expect(candidates.at(-1)).toBe("codex.exe");
  });

  test("supplements an incomplete provider cache with missing visible Desktop models", () => {
    const supplemented = supplementMissingModels(
      {
        models: [{
          slug: "gpt-5.6-sol",
          display_name: "Cache Sol",
          visibility: "list",
          context_window: 272_000,
        }],
      },
      {
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "Bundled Sol",
            visibility: "list",
            context_window: 999_000,
          },
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6-Astra",
            visibility: "list",
            context_window: 1_050_000,
          },
          {
            slug: "internal-only",
            display_name: "Internal",
            visibility: "hide",
          },
        ],
      },
    );

    expect(supplemented.models).toEqual([
      {
        slug: "gpt-5.6-sol",
        display_name: "Cache Sol",
        visibility: "list",
        context_window: 272_000,
      },
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6-Astra",
        visibility: "list",
        context_window: 1_050_000,
      },
    ]);
  });

  test("expands a configured tilde Codex home consistently with launcher paths", () => {
    process.env.CODEX_HOME = "~/custom-codex-home";
    expect(getCodexHome()).toBe(join(homedir(), "custom-codex-home"));
  });

  test("reads the selected model's explicit context override from Codex config", () => {
    const { codexHome } = fixture();
    writeFileSync(
      join(codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_context_window = 371_851 # explicit override\n',
    );

    expect(readCodexModelContextOverride()).toEqual({
      model: "gpt-5.6-sol",
      contextWindow: 371_851,
    });
  });

  test("keeps the built-in openai provider while reversibly pinning remote compaction to v1", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.version).toBe(9);
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain(`model_catalog_json = ${JSON.stringify(getCodexManagedCatalogPath())}`);
    expect(existsSync(getCodexManagedCatalogPath())).toBe(true);
    expect(installed).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).toContain("multi_agent = false # user choice");
    expect(installed).not.toContain("multi_agent_v2");
    expect(installed).toContain("goals = true");
    expect(installed).not.toMatch(/^\s*model_provider\s*=/m);
    expect(installed).toMatch(/^\s*model_catalog_json\s*=/m);
    expect(installed).not.toContain("[model_providers.codex-chatgpt-web]");
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8"))
      .toBe(readFileSync(getCodexJournalPath(), "utf8"));

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(getCodexManagedCatalogPath())).toBe(false);
    expect(existsSync(getCodexJournalRecoveryPath())).toBe(false);
    expect(uninstallCodexIntegration()).toEqual({ changed: false });
  });

  test("temporarily disables remote compaction v2 without changing multi-agent feature flags", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "remote_compaction_v2 = true # native choice",
      "multi_agent = false # native choice",
      "multi_agent_v2 = true # native choice",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).toContain("multi_agent = false # native choice");
    expect(installed).toContain("multi_agent_v2 = true # native choice");
    expect(journal.installed).toEqual({
      openai_base_url: "http://127.0.0.1:17841/v1",
      model_catalog_json: getCodexManagedCatalogPath(),
      remote_compaction_v2: false,
    });
    expect(journal.previousRemoteCompactionV2).toMatchObject({
      present: true,
      rawLine: "remote_compaction_v2 = true # native choice",
      value: "true",
      tablePresent: true,
    });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restores a missing primary journal from its exact recovery copy", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const recovery = readFileSync(getCodexJournalRecoveryPath(), "utf8");
    rmSync(getCodexJournalPath());

    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(recovery);
  });

  test("refuses different journal baselines when both match the same config", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const recovery = JSON.parse(readFileSync(getCodexJournalRecoveryPath(), "utf8"));
    recovery.previous.model_provider = { present: false, rawLine: "different but inactive evidence" };
    writeFileSync(getCodexJournalRecoveryPath(), `${JSON.stringify(recovery, null, 2)}\n`);

    expect(() => inspectCodexIntegration()).toThrow("different baselines");
  });

  test("reconciles either side of a crash between recovery intent, config, and primary commit", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const activeConfig = readFileSync(configPath, "utf8");
    const activeJournal = readFileSync(getCodexJournalPath(), "utf8");

    deactivateCodexIntegration();
    const inactiveConfig = readFileSync(configPath, "utf8");
    const inactiveJournal = readFileSync(getCodexJournalRecoveryPath(), "utf8");

    // Recovery intent and config reached disk, but primary still describes the old active state.
    writeFileSync(getCodexJournalPath(), activeJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(inactiveJournal);

    // Only the next active intent reached disk; physical config and primary are still inactive.
    writeFileSync(getCodexJournalRecoveryPath(), activeJournal);
    writeFileSync(configPath, inactiveConfig);
    writeFileSync(getCodexJournalPath(), inactiveJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(inactiveJournal);
    expect(readFileSync(configPath, "utf8")).not.toBe(activeConfig);
  });

  test("accepts an explicitly persisted built-in openai provider and restores it exactly", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nmodel_provider = "openai" # explicit built-in default\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(defaultConfig("browser-only"))).not.toThrow();
    installCodexIntegration(defaultConfig("browser-only"));
    expect(readFileSync(configPath, "utf8")).toContain(
      'model_provider = "openai" # explicit built-in default',
    );

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves an explicit remote_compaction_v2 setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nremote_compaction_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("fails closed if remote_compaction_v2 is changed while the bridge owns it", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n\n[features]\nremote_compaction_v2 = true # user baseline\n');
    installCodexIntegration(defaultConfig("browser-only"));
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "remote_compaction_v2 = false # Managed by codex-chatgpt-web: uses bounded /responses/compact history.",
        "remote_compaction_v2 = true # changed while active",
      ),
    );

    expect(() => inspectCodexIntegration()).not.toThrow();
    expect(inspectCodexIntegration().errors.join("\n")).toContain("remote_compaction_v2 changed after setup");
    expect(() => deactivateCodexIntegration()).toThrow("remote_compaction_v2 changed after setup");
  });

  test("preserves an explicit multi_agent setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent = false # user choice");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves an explicit multi_agent_v2 setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent_v2 = true # user choice");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves the structured multi_agent_v2 feature table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[features.multi_agent_v2]",
      "enabled = true # user choice",
      "hide_spawn_agent_metadata = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("enabled = true # user choice");
    expect(installed).toContain("hide_spawn_agent_metadata = true");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("writes a static managed catalog with deterministic Web context metadata", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');

    installCodexIntegration(defaultConfig("browser-only"));
    const catalog = JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8")) as {
      models: Array<{ slug?: string; context_window?: number; auto_compact_token_limit?: number }>;
    };
    expect(catalog.models.some(model => model.slug === "gpt-5.6-sol")).toBe(true);
    expect(catalog.models.find(model => model.slug === "chatgpt-web/light")).toMatchObject({
      context_window: 41_000,
      auto_compact_token_limit: 32_000,
    });
    expect(readFileSync(configPath, "utf8"))
      .toContain(`model_catalog_json = ${JSON.stringify(getCodexManagedCatalogPath())}`);
  });

  test("augments a user catalog without modifying it and restores its assignment on uninstall", () => {
    const { root, codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const sourceCatalog = join(root, "user-models.json");
    const source = JSON.parse(readFileSync(getCodexModelsCachePath(), "utf8"));
    source.models.push({
      slug: "user-native-model",
      display_name: "User Native",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [],
      tool_mode: "code_mode_only",
    });
    const sourceText = `${JSON.stringify(source, null, 2)}\n`;
    writeFileSync(sourceCatalog, sourceText);
    const original = `model = "gpt-5.6-sol"\nmodel_catalog_json = ${JSON.stringify(sourceCatalog)}\n`;
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const managed = JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8")) as {
      models: Array<{ slug?: string }>;
    };
    expect(managed.models.some(model => model.slug === "user-native-model")).toBe(true);
    expect(managed.models.some(model => model.slug === "chatgpt-web/high")).toBe(true);
    expect(readFileSync(sourceCatalog, "utf8")).toBe(sourceText);

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readFileSync(sourceCatalog, "utf8")).toBe(sourceText);
  });

  test("fails closed when the managed catalog assignment or file is changed", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const config = defaultConfig("browser-only");
    installCodexIntegration(config);
    const validManagedCatalog = readFileSync(getCodexManagedCatalogPath(), "utf8");

    writeFileSync(getCodexManagedCatalogPath(), '{"models":[]}\n');
    expect(inspectCodexIntegration().errors.join("\n")).toContain("changed after setup");
    expect(() => uninstallCodexIntegration()).toThrow("changed after setup");

    // Restore the exact managed file, then prove explicit route replacement still refuses a changed
    // catalog assignment rather than adopting it as the next baseline.
    writeFileSync(getCodexManagedCatalogPath(), validManagedCatalog);
    const changed = readFileSync(configPath, "utf8")
      .replace(
        `model_catalog_json = ${JSON.stringify(getCodexManagedCatalogPath())}`,
        'model_catalog_json = "user-overrode-managed-catalog.json"',
      );
    writeFileSync(configPath, changed);
    expect(() => installCodexIntegration(config, { replaceExistingRoute: true }))
      .toThrow("model_catalog_json changed after setup");
  });

  test("invalidates Codex's provider-agnostic model cache on install and uninstall", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const cachePath = getCodexModelsCachePath();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    expect(existsSync(cachePath)).toBe(true);

    installCodexIntegration(defaultConfig("browser-only"));
    expect(() => readFileSync(cachePath, "utf8")).toThrow();

    writeFileSync(cachePath, '{"models":["native-and-web"]}\n');
    uninstallCodexIntegration();
    expect(() => readFileSync(cachePath, "utf8")).toThrow();
  });

  test("requires explicit replacement and preserves every non-port route assignment", () => {
    const { root, codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const sourceCatalog = join(root, "native.json");
    writeFileSync(sourceCatalog, readFileSync(getCodexModelsCachePath(), "utf8"));
    const original = `model = "gpt-5.6-sol"\nmodel_provider = "existing-provider"\nopenai_base_url = "http://127.0.0.1:9999/v1"\nmodel_catalog_json = ${JSON.stringify(sourceCatalog)}\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);
    const config = defaultConfig("full");

    expect(() => installCodexIntegration(config)).toThrow("--replace-codex-route");
    installCodexIntegration(config, { replaceExistingRoute: true });
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain('model_provider = "existing-provider"');
    expect(installed).toContain(`model_catalog_json = ${JSON.stringify(getCodexManagedCatalogPath())}`);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("v8 route ownership survives comment-only Codex rewrites", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');

    installCodexIntegration(defaultConfig("browser-only"));
    const rewritten = readFileSync(configPath, "utf8")
      .replace(/^# Managed by codex-chatgpt-web;.*\r?\n/m, "");
    writeFileSync(configPath, rewritten);

    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
    expect(activateCodexIntegration()).toEqual({ changed: false, active: true });
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("owns only the route and managed catalog while preserving unrelated user edits", () => {
    const { root, codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const sourceCatalog = join(root, "first.json");
    writeFileSync(sourceCatalog, readFileSync(getCodexModelsCachePath(), "utf8"));
    const original = [
      'model = "gpt-5.6-sol"',
      'model_provider = "first-provider"',
      `model_catalog_json = ${JSON.stringify(sourceCatalog)}`,
      "",
      "[features]",
      "multi_agent = true",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("full"));
    const userEdited = readFileSync(configPath, "utf8")
      .replace('model_provider = "first-provider"', 'model_provider = "second-provider"')
      .replace("multi_agent = true", "multi_agent = false");
    writeFileSync(configPath, userEdited);

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    const restored = readFileSync(configPath, "utf8");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).toContain('model_provider = "second-provider"');
    expect(restored).toContain(`model_catalog_json = ${JSON.stringify(sourceCatalog)}`);
    expect(restored).toContain("multi_agent = false");
  });

  test("preflight detects route conflicts without changing Codex or creating a journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:9999/v1"\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(defaultConfig("browser-only")))
      .toThrow("--replace-codex-route");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(() => readFileSync(getCodexJournalPath(), "utf8")).toThrow();
  });

  test("updates its own route idempotently without changing the preserved baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const first = defaultConfig("browser-only");
    const firstJournal = installCodexIntegration(first);
    expect(existsSync(getCodexModelsCachePath())).toBe(false);
    const installed = readFileSync(configPath, "utf8");
    expect(buildManagedCodexModelCatalog(first, installed, undefined, {
      path: firstJournal.catalogPath,
      sha256: firstJournal.catalogSha256,
    })).toMatchObject({
      source: "managed",
      sourcePath: getCodexManagedCatalogPath(),
    });
    const second = defaultConfig("browser-only");
    second.port = 17842;
    installCodexIntegration(second);
    expect(readFileSync(configPath, "utf8")).toContain('openai_base_url = "http://127.0.0.1:17842/v1"');
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("disconnects and reconnects the bridge without losing the prior route or journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\napproval_policy = "never"\nopenai_base_url = "https://native.example/v1"\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"), { replaceExistingRoute: true });
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false });
    expect(deactivateCodexIntegration()).toEqual({ changed: false, active: false });

    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    const reconnected = readFileSync(configPath, "utf8");
    expect(reconnected).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(reconnected).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(reconnected).not.toContain("multi_agent");
    expect(reconnected).toContain('approval_policy = "never"');
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true });
    expect(activateCodexIntegration()).toEqual({ changed: false, active: true });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("refreshes newly available native models from a fresh cache while the bridge is already active", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const nativeCatalog = JSON.parse(readFileSync(getCodexModelsCachePath(), "utf8"));
    const nativeTemplate = nativeCatalog.models[0];
    const installed = installCodexIntegration(defaultConfig("browser-only"));
    expect(existsSync(getCodexModelsCachePath())).toBe(false);

    const astra = {
      ...structuredClone(nativeTemplate),
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      context_window: 1_050_000,
      max_context_window: 1_050_000,
      auto_compact_token_limit: 997_500,
    };
    writeFileSync(getCodexModelsCachePath(), `${JSON.stringify({ models: [nativeTemplate, astra] }, null, 2)}\n`);

    expect(activateCodexIntegration(defaultConfig("browser-only"))).toEqual({ changed: true, active: true });
    expect(existsSync(getCodexModelsCachePath())).toBe(false);
    const refreshed = JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8"));
    expect(refreshed.models.map((model: { slug: string }) => model.slug)).toContain("gpt-6-astra");
    const refreshedJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    expect(refreshedJournal.catalogSha256).not.toBe(installed.catalogSha256);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
  });

  test("refreshes newly available native models from the direct Codex cache when reconnecting", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const nativeCatalog = JSON.parse(readFileSync(getCodexModelsCachePath(), "utf8"));
    const nativeTemplate = nativeCatalog.models[0];

    const installed = installCodexIntegration(defaultConfig("browser-only"));
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(existsSync(getCodexModelsCachePath())).toBe(false);

    const astra = {
      ...structuredClone(nativeTemplate),
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      context_window: 1_050_000,
      max_context_window: 1_050_000,
      auto_compact_token_limit: 997_500,
    };
    writeFileSync(getCodexModelsCachePath(), `${JSON.stringify({ models: [nativeTemplate, astra] }, null, 2)}\n`);

    expect(activateCodexIntegration(defaultConfig("browser-only"))).toEqual({ changed: true, active: true });
    expect(existsSync(getCodexModelsCachePath())).toBe(false);
    const refreshed = JSON.parse(readFileSync(getCodexManagedCatalogPath(), "utf8"));
    const refreshedSlugs = refreshed.models.map((model: { slug: string }) => model.slug);
    expect(refreshedSlugs).toContain("gpt-5.6-sol");
    expect(refreshedSlugs).toContain("gpt-6-astra");
    expect(refreshedSlugs).toContain("chatgpt-web/light");
    expect(refreshedSlugs).toContain("chatgpt-web/medium");
    expect(refreshedSlugs).toContain("chatgpt-web/high");
    expect(refreshed.models.find((model: { slug: string }) => model.slug === "gpt-5.6-sol"))
      .toMatchObject(nativeTemplate);
    const reconnectedJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    expect(reconnectedJournal.catalogSha256).not.toBe(installed.catalogSha256);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
  });

  test("keeps a disconnected bridge disabled across process-style journal reloads", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();

    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 9,
      active: false,
    });
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("upgrades an existing v3 route journal when it is disconnected for the first time", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n';
    writeFileSync(configPath, original);
    installCodexIntegration(defaultConfig("browser-only"));
    const previous = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    const legacyInstalled = readFileSync(configPath, "utf8")
      .replace(/^model_catalog_json\s*=.*\n/gm, "")
      .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, "");
    writeFileSync(configPath, legacyInstalled);
    delete previous.active;
    delete previous.previousRemoteCompactionV2;
    delete previous.previousMultiAgent;
    delete previous.previousMultiAgentV2;
    delete previous.installed.model_catalog_json;
    delete previous.installed.remote_compaction_v2;
    delete previous.installed.multi_agent;
    delete previous.installed.multi_agent_v2;
    delete previous.catalogPath;
    delete previous.catalogSha256;
    previous.version = 3;
    const legacyJournal = `${JSON.stringify(previous, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 4,
      active: false,
    });
  });

  test("upgrades an active v4 route journal without changing native features", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    delete legacy.previousRemoteCompactionV2;
    delete legacy.previousMultiAgent;
    delete legacy.previousMultiAgentV2;
    delete legacy.installed.model_catalog_json;
    delete legacy.installed.remote_compaction_v2;
    delete legacy.installed.multi_agent;
    delete legacy.installed.multi_agent_v2;
    delete legacy.catalogPath;
    delete legacy.catalogSha256;
    legacy.version = 4;
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8")
        .replace(/^model_catalog_json\s*=.*\n/gm, "")
        .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, ""),
    );
    // Legacy v4 journals did not authenticate an AsterBridge-managed catalog. Recreate the native
    // provider cache fixture so this migration test does not depend on an installed system Codex CLI.
    writeFileSync(getCodexModelsCachePath(), readFileSync(getCodexManagedCatalogPath(), "utf8"));

    const upgraded = installCodexIntegration(defaultConfig("browser-only"));
    expect(upgraded.version).toBe(9);
    expect(readFileSync(configPath, "utf8")).toContain("goals = true");
    expect(readFileSync(configPath, "utf8")).toContain("remote_compaction_v2 = false # Managed by codex-chatgpt-web");
    expect(readFileSync(configPath, "utf8")).not.toContain("multi_agent");
  });

});
