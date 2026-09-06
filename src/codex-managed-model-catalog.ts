import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { expandUserPath } from "./config";
import { augmentNativeModelCatalog } from "./model-catalog";
import type { CodexModelContextOverride } from "./codex-integration-shared";
import {
  getCodexManagedCatalogPath,
  getCodexModelsCachePath,
  sha256,
} from "./codex-integration-shared";
import { findTopLevelAssignment, splitLines } from "./codex-integration-document";

interface CatalogObject extends Record<string, unknown> {
  models: unknown[];
}

export interface ManagedCodexModelCatalog {
  path: string;
  data: string;
  source: "configured" | "cache" | "managed" | "bundled";
  sourcePath?: string;
}

export interface TrustedManagedCatalogSource {
  path: string;
  sha256: string;
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

function discoverWindowsDesktopCodexExecutables(localAppData = process.env.LOCALAPPDATA?.trim()): string[] {
  if (!localAppData) return [];
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(root)) return [];
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  try {
    const direct = join(root, "codex.exe");
    if (existsSync(direct)) candidates.push({ path: direct, mtimeMs: statSync(direct).mtimeMs });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "codex.exe");
      if (!existsSync(path)) continue;
      try { candidates.push({ path, mtimeMs: statSync(path).mtimeMs }); } catch { /* raced with updater cleanup */ }
    }
  } catch {
    return [];
  }
  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map(candidate => candidate.path);
}

export function codexBundledCatalogExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  discoveredDesktopExecutables = platform === "win32" ? discoverWindowsDesktopCodexExecutables(env.LOCALAPPDATA?.trim()) : [],
): string[] {
  const candidates: string[] = [];
  const explicit = env.CODEX_CLI_PATH?.trim();
  if (explicit) candidates.push(resolve(expandUserPath(explicit)));
  if (platform === "win32") {
    candidates.push(...discoveredDesktopExecutables);
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) candidates.push(join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
    candidates.push("codex.exe");
  } else {
    candidates.push("codex");
  }
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bundledCatalog(): { catalog: CatalogObject; executable: string } {
  const failures: string[] = [];
  for (const executable of codexBundledCatalogExecutableCandidates()) {
    const result = spawnSync(executable, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) {
      failures.push(`${executable}: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0 || !result.stdout?.trim()) {
      const detail = result.stderr?.trim().replace(/\s+/g, " ").slice(0, 180);
      failures.push(`${executable}: exit ${String(result.status)}${detail ? ` (${detail})` : ""}`);
      continue;
    }
    try {
      return {
        catalog: parseCatalog(result.stdout, `Codex bundled model catalog from ${executable}`),
        executable,
      };
    } catch (error) {
      failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const detail = failures.slice(0, 3).join("; ");
  throw new Error(
    `Codex bundled model catalog could not be read${detail ? `: ${detail}` : ""}. `
    + "Run the current Codex Desktop once to populate its model cache, then rerun AsterBridge setup.",
  );
}

function supplementMissingModels(primary: CatalogObject, supplemental: CatalogObject): CatalogObject {
  const models = structuredClone(primary.models);
  const slugs = new Set(models.map(model => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
    const value = (model as Record<string, unknown>).slug;
    return typeof value === "string" ? value : undefined;
  }).filter((value): value is string => Boolean(value)));
  for (const model of supplemental.models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) continue;
    const row = model as Record<string, unknown>;
    const value = row.slug;
    if (typeof value !== "string" || slugs.has(value) || row.visibility !== "list") continue;
    models.push(structuredClone(model));
    slugs.add(value);
  }
  return { ...structuredClone(primary), models };
}

function sourceCatalog(
  configText: string,
  trustedManaged?: TrustedManagedCatalogSource,
  supplementBundled = false,
): {
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
      // A stale or partially-written provider-agnostic cache must not block setup when another
      // previously validated Codex catalog source is still available.
    }
  }

  const managedPath = getCodexManagedCatalogPath();
  if (trustedManaged && resolve(trustedManaged.path) === resolve(managedPath) && existsSync(managedPath)) {
    const data = readFileSync(managedPath, "utf8");
    if (sha256(data) !== trustedManaged.sha256) {
      throw new Error(`Managed Codex model catalog changed after setup: ${managedPath}`);
    }
    const managed = parseCatalog(data, `Managed Codex model catalog ${managedPath}`);
    if (supplementBundled) {
      try {
        const bundled = bundledCatalog();
        return {
          // A trusted direct/provider cache remains more authoritative than bundled metadata. When no
          // cache is available, only add bundled slugs that the managed catalog does not know yet.
          // This lets a newly updated Codex Desktop surface a newly shipped model without allowing an
          // older standalone binary on PATH to downgrade account/rollout-specific managed rows.
          catalog: supplementMissingModels(managed, bundled.catalog),
          source: "managed",
          sourcePath: managedPath,
        };
      } catch {
        // A previously authenticated managed catalog remains a safe fallback when Codex itself is
        // unavailable. Route activation must not fail merely because the Desktop binary is closed or
        // an updater is between executable swaps.
      }
    }
    return {
      catalog: managed,
      source: "managed",
      sourcePath: managedPath,
    };
  }

  const bundled = bundledCatalog();
  return { catalog: bundled.catalog, source: "bundled", sourcePath: bundled.executable };
}

export function buildManagedCodexModelCatalog(
  config: AppConfig,
  configText: string,
  contextOverride?: CodexModelContextOverride,
  trustedManaged?: TrustedManagedCatalogSource,
  options: { supplementBundled?: boolean } = {},
): ManagedCodexModelCatalog {
  const source = sourceCatalog(configText, trustedManaged, options.supplementBundled === true);
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
