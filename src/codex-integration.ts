import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config";
import {
  buildManagedCodexModelCatalog,
  type TrustedManagedCatalogSource,
} from "./codex-managed-model-catalog";
import { atomicWriteFile } from "./config";
import {
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexManagedCatalogPath,
  getCodexModelsCachePath,
  restoreFileSnapshot,
  routeUrl,
  sha256,
  snapshotFile,
  writeIntegrationState,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import {
  findTopLevelAssignment,
  readCodexModelContextOverride,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertPreservedPreviousAssignments,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyManagedCatalog,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

export {
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexManagedCatalogPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride };
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

function trustedManagedCatalogSource(journal: AnyCodexIntegrationJournal | undefined): TrustedManagedCatalogSource | undefined {
  return journal && (journal.version === 8 || journal.version === 9)
    ? { path: journal.catalogPath, sha256: journal.catalogSha256 }
    : undefined;
}

function refreshActiveManagedCatalog(
  config: AppConfig,
  current: string,
  existing: CodexIntegrationJournal | LegacyCodexIntegrationJournalV8,
): SetCodexIntegrationActiveResult {
  verifyManagedJournalState(current, existing);
  const refreshed = buildManagedCodexModelCatalog(
    config,
    current,
    readCodexModelContextOverride(),
    trustedManagedCatalogSource(existing),
    { supplementBundled: true },
  );
  if (refreshed.path !== existing.catalogPath) {
    throw new Error("Refreshed Codex model catalog resolved to an unexpected path");
  }
  const refreshedSha256 = sha256(refreshed.data);
  const cachePath = getCodexModelsCachePath();
  const removals = existsSync(cachePath) ? [cachePath] : [];
  if (refreshedSha256 === existing.catalogSha256) {
    if (removals.length > 0) writeIntegrationState(existing, undefined, removals);
    return { changed: false, active: true };
  }
  const refreshedJournal = { ...existing, catalogSha256: refreshedSha256 };
  writeIntegrationState(
    refreshedJournal,
    undefined,
    removals,
    [{ path: refreshed.path, data: refreshed.data }],
  );
  return { changed: true, active: true };
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  const configPath = getCodexConfigPath();
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const validate = (baseline: string, replaceExistingRoute: boolean): void => {
    installRoute(
      baseline,
      {
        openai_base_url: routeUrl(config),
        model_catalog_json: getCodexManagedCatalogPath(),
        remote_compaction_v2: false,
      },
      replaceExistingRoute,
    );
    const catalog = buildManagedCodexModelCatalog(
      config,
      baseline,
      readCodexModelContextOverride(),
      trustedManagedCatalogSource(existing),
    );
    if (catalog.path !== getCodexManagedCatalogPath()) {
      throw new Error("Managed Codex model catalog resolved to an unexpected path");
    }
  };
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing && existing.version !== 2) {
    if (!configExists) {
      if (options.replaceExistingRoute !== true) {
        throw new Error(`Codex config is missing: ${configPath}`);
      }
      validate("", true);
      return;
    }
    try {
      verifyManagedJournalState(currentText, existing);
      validate(managedJournalIsActive(existing) ? restoreManagedRoute(currentText, existing) : currentText, true);
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      validate(replacementBaseline(currentText, configExists, existing), true);
    }
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  validate(baseline, options.replaceExistingRoute === true);
}
export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  let baseline = currentText;
  let preservePrevious = false;
  if (existing && existing.version !== 2) {
    preservePrevious = true;
    try {
      verifyManagedJournalState(currentText, existing);
      baseline = managedJournalIsActive(existing)
        ? restoreManagedRoute(currentText, existing)
        : currentText;
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
  } else if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }

  const installed = {
    openai_base_url: routeUrl(config),
    model_catalog_json: getCodexManagedCatalogPath(),
    remote_compaction_v2: false as const,
  };
  const patched = installRoute(
    baseline,
    installed,
    existing && existing.version !== 2 ? true : options.replaceExistingRoute === true,
  );
  const catalog = buildManagedCodexModelCatalog(
    config,
    baseline,
    readCodexModelContextOverride(),
    trustedManagedCatalogSource(existing),
  );
  if (catalog.path !== installed.model_catalog_json) {
    throw new Error("Managed Codex model catalog resolved to an unexpected path");
  }
  if (!patched.previousRemoteCompactionV2) {
    throw new Error("Codex integration did not record the prior remote_compaction_v2 setting");
  }
  if (existing && existing.version !== 2 && preservePrevious) {
    assertPreservedPreviousAssignments(
      patched.previous,
      existing.previous,
      existing.version === 8 || existing.version === 9,
    );
  }
  const previous = existing && existing.version !== 2 && preservePrevious
    ? existing.version === 8 || existing.version === 9
      ? existing.previous
      : { ...patched.previous, openai_base_url: existing.previous.openai_base_url }
    : patched.previous;
  const previousRemoteCompactionV2 = existing && existing.version === 9 && preservePrevious
    ? existing.previousRemoteCompactionV2
    : patched.previousRemoteCompactionV2;
  const journal: CodexIntegrationJournal = {
    version: 9,
    active: true,
    configPath,
    catalogPath: catalog.path,
    catalogSha256: sha256(catalog.data),
    installed,
    previous,
    previousRemoteCompactionV2,
    ...(existing && existing.version !== 2 && existing.format
      ? { format: existing.format }
      : { format: textFormat(baseline) }),
  };
  const removals = [getCodexModelsCachePath()];
  if (existing?.version === 2 && existing.catalogPath !== catalog.path) removals.push(existing.catalogPath);
  writeIntegrationState(
    journal,
    { path: configPath, data: patched.text },
    removals,
    [{ path: catalog.path, data: catalog.data }],
  );
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version !== 3 && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 9
      || existing.version === 8
      || existing.version === 7
      || existing.version === 6
      || existing.version === 5
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  writeIntegrationState(disconnected, { path: existing.configPath, data: restored }, [getCodexModelsCachePath()]);
  return { changed: true, active: false };
}

export function activateCodexIntegration(config?: AppConfig): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version === 9) {
    if (existing.active) {
      if (!config) {
        verifyManagedJournalState(current, existing);
        return { changed: false, active: true };
      }
      return refreshActiveManagedCatalog(config, current, existing);
    }
    verifyRestoredRoute(current, existing);
    verifyManagedCatalog(existing);
    const refreshedCatalog = config
      ? buildManagedCodexModelCatalog(
          config,
          current,
          readCodexModelContextOverride(),
          trustedManagedCatalogSource(existing),
          { supplementBundled: true },
        )
      : undefined;
    if (refreshedCatalog && refreshedCatalog.path !== existing.catalogPath) {
      throw new Error("Refreshed Codex model catalog resolved to an unexpected path");
    }
    const route = installRoute(current, existing.installed, true);
    assertPreservedPreviousAssignments(route.previous, existing.previous, true);
    if (!route.previousRemoteCompactionV2
      || route.previousRemoteCompactionV2.present !== existing.previousRemoteCompactionV2.present
      || route.previousRemoteCompactionV2.rawLine !== existing.previousRemoteCompactionV2.rawLine
      || route.previousRemoteCompactionV2.tablePresent !== existing.previousRemoteCompactionV2.tablePresent) {
      throw new Error("Codex remote_compaction_v2 changed while the bridge was disconnected; refusing to replace it");
    }
    const connected: CodexIntegrationJournal = refreshedCatalog
      ? { ...existing, active: true, catalogSha256: sha256(refreshedCatalog.data) }
      : { ...existing, active: true };
    writeIntegrationState(
      connected,
      { path: existing.configPath, data: route.text },
      [getCodexModelsCachePath()],
      refreshedCatalog ? [{ path: refreshedCatalog.path, data: refreshedCatalog.data }] : [],
    );
    return { changed: true, active: true };
  }
  if (existing.version === 8) {
    if (existing.active) {
      if (!config) {
        verifyManagedJournalState(current, existing);
        return { changed: false, active: true };
      }
      return refreshActiveManagedCatalog(config, current, existing);
    }
    verifyRestoredRoute(current, existing);
    verifyManagedCatalog(existing);
    const refreshedCatalog = config
      ? buildManagedCodexModelCatalog(
          config,
          current,
          readCodexModelContextOverride(),
          trustedManagedCatalogSource(existing),
          { supplementBundled: true },
        )
      : undefined;
    if (refreshedCatalog && refreshedCatalog.path !== existing.catalogPath) {
      throw new Error("Refreshed Codex model catalog resolved to an unexpected path");
    }
    const route = installRoute(current, existing.installed, true);
    assertPreservedPreviousAssignments(route.previous, existing.previous, true);
    const connected: LegacyCodexIntegrationJournalV8 = refreshedCatalog
      ? { ...existing, active: true, catalogSha256: sha256(refreshedCatalog.data) }
      : { ...existing, active: true };
    writeIntegrationState(
      connected,
      { path: existing.configPath, data: route.text },
      [getCodexModelsCachePath()],
      refreshedCatalog ? [{ path: refreshedCatalog.path, data: refreshedCatalog.data }] : [],
    );
    return { changed: true, active: true };
  }
  if (existing.version !== 3 && existing.active) {
    verifyInstalledRoute(current, existing);
    return { changed: false, active: true };
  }
  let baseline: string;
  if (existing.version !== 3 && !existing.active) {
    verifyRestoredRoute(current, existing);
    baseline = current;
  } else {
    verifyInstalledRoute(current, existing);
    baseline = restoreManagedRoute(current, existing);
  }
  const route = installRoute(
    baseline,
    { openai_base_url: existing.installed.openai_base_url },
    true,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  const connected: LegacyCodexIntegrationJournalV7 = {
    version: 7,
    active: true,
    configPath: existing.configPath,
    installed: { openai_base_url: existing.installed.openai_base_url },
    previous: existing.previous,
    ...(existing.format ? { format: existing.format } : {}),
  };
  writeIntegrationState(connected, { path: existing.configPath, data: route.text }, [getCodexModelsCachePath()]);
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if (journal.version !== 3 && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    restored = restoreManagedRoute(current, journal);
  }
  if ((journal.version === 8 || journal.version === 9) && existsSync(journal.catalogPath)
    && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
    throw new Error(`Managed Codex model catalog changed after setup: ${journal.catalogPath}`);
  }
  const configSnapshot = snapshotFile(journal.configPath);
  const catalogSnapshot = journal.version === 2 || journal.version === 8 || journal.version === 9
    ? snapshotFile(journal.catalogPath)
    : undefined;
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  const journalSnapshot = snapshotFile(getCodexJournalPath());
  const recoverySnapshot = snapshotFile(getCodexJournalRecoveryPath());
  try {
    atomicWriteFile(journal.configPath, restored);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
    rmSync(getCodexJournalRecoveryPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [recoverySnapshot, journalSnapshot, modelsCacheSnapshot, catalogSnapshot, configSnapshot]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if (journal.version === 2) {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      } else if (journal.version !== 3 && !journal.active) {
        verifyRestoredRoute(text, journal);
        if (journal.version === 8 || journal.version === 9) verifyManagedCatalog(journal);
      } else {
        verifyManagedJournalState(text, journal);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal && journal.version !== 2 && journal.version !== 3
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal && journal.version !== 2
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
