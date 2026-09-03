import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config";
import { expandUserPath } from "./config";
import { augmentNativeModelCatalog } from "./model-catalog";
import type { CodexModelContextOverride } from "./codex-integration-shared";
import {
  getCodexManagedCatalogPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
import { findTopLevelAssignment, splitLines } from "./codex-integration-document";

interface CatalogObject extends Record<string, unknown> {
  models: unknown[];
}

export interface ManagedCodexModelCatalog {
  path: string;
  data: string;
  source: "configured" | "cache" | "bundled";
  sourcePath?: string;
}

function parseCatalog(text: string, label: string): CatalogObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error(`${label} is missing a non-empty models array`);
  }
  return catalog as CatalogObject;
}

function configuredCatalogPath(configText: string): string | undefined {
  const value = findTopLevelAssignment(splitLines(configText), "model_catalog_json").value?.trim();
  if (!value) return undefined;
  const path = resolve(expandUserPath(value));
  return path === resolve(getCodexManagedCatalogPath()) ? undefined : path;
}

function bundledCatalog(): CatalogObject {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const result = spawnSync(executable, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `Codex model metadata is unavailable: ${result.error.message}. `
      + "Run Codex once to populate its model cache, then rerun AsterBridge setup.",
    );
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    const detail = result.stderr?.trim().slice(0, 300);
    throw new Error(
      `Codex bundled model catalog could not be read${detail ? `: ${detail}` : ""}. `
      + "Run Codex once to populate its model cache, then rerun AsterBridge setup.",
    );
  }
  return parseCatalog(result.stdout, "Codex bundled model catalog");
}

function sourceCatalog(configText: string): {
  catalog: CatalogObject;
  source: ManagedCodexModelCatalog["source"];
  sourcePath?: string;
} {
  const configured = configuredCatalogPath(configText);
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`Configured Codex model catalog does not exist: ${configured}`);
    }
    return {
      catalog: parseCatalog(readFileSync(configured, "utf8"), `Configured Codex model catalog ${configured}`),
      source: "configured",
      sourcePath: configured,
    };
  }

  const cachePath = getCodexModelsCachePath();
  if (existsSync(cachePath)) {
    try {
      return {
        catalog: parseCatalog(readFileSync(cachePath, "utf8"), `Codex model cache ${cachePath}`),
        source: "cache",
        sourcePath: cachePath,
      };
    } catch {
      // A stale or partially-written provider-agnostic cache must not block setup when the bundled
      // catalog from the installed Codex binary is still available.
    }
  }

  return { catalog: bundledCatalog(), source: "bundled" };
}

export function buildManagedCodexModelCatalog(
  config: AppConfig,
  configText: string,
  contextOverride?: CodexModelContextOverride,
): ManagedCodexModelCatalog {
  const source = sourceCatalog(configText);
  const augmented = augmentNativeModelCatalog(source.catalog, config, contextOverride);
  const models = augmented.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Managed Codex model catalog contains no models after augmentation");
  }
  return {
    path: getCodexManagedCatalogPath(),
    data: `${JSON.stringify({ models }, null, 2)}\n`,
    source: source.source,
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
  };
}
