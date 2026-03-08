/**
 * Scope detection — maps cwd or Obsidian paths to project scopes.
 * Loads scope map from ~/.engram/config.json if available,
 * falls back to built-in defaults.
 */
import fs from "node:fs";
import path from "node:path";

/** Default cwd → scope mapping (empty — configure via ~/.engram/config.json) */
const DEFAULT_SCOPE_MAP: Record<string, string> = {};

/** Default Obsidian relative path → scope mapping (empty — configure via ~/.engram/config.json) */
const DEFAULT_OBSIDIAN_SCOPE_MAP: Record<string, string> = {};

interface ScopeConfig {
  scopeMap?: Record<string, string>;
  obsidianScopeMap?: Record<string, string>;
}

// Config is cached for the lifetime of the process.
// Changes to ~/.engram/config.json require a server restart to take effect.
let _cachedConfig: ScopeConfig | null = null;

/**
 * Load scope configuration from ~/.engram/config.json.
 * Returns defaults if config file doesn't exist or is invalid.
 */
function loadConfig(): ScopeConfig {
  if (_cachedConfig) return _cachedConfig;

  const configPath = path.join(
    process.env.HOME || "~",
    ".engram",
    "config.json"
  );

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as ScopeConfig;
      _cachedConfig = parsed;
      return parsed;
    }
  } catch {
    // Invalid config — fall back to defaults
  }

  _cachedConfig = {};
  return _cachedConfig;
}

/** Reset cached config (for testing). */
export function resetScopeConfigCache(): void {
  _cachedConfig = null;
}

/**
 * Detect scope from a working directory path.
 */
export function detectScope(cwd: string): string {
  const config = loadConfig();
  const scopeMap = config.scopeMap || DEFAULT_SCOPE_MAP;

  for (const [scope, pathFragment] of Object.entries(scopeMap)) {
    if (cwd.includes(pathFragment)) return scope;
  }
  return "global";
}

/**
 * Detect scope from an Obsidian vault-relative file path.
 */
export function detectObsidianScope(relativePath: string): string {
  const config = loadConfig();
  const obsidianScopeMap = config.obsidianScopeMap || DEFAULT_OBSIDIAN_SCOPE_MAP;

  for (const [prefix, scope] of Object.entries(obsidianScopeMap)) {
    if (relativePath.startsWith(prefix)) return scope;
  }
  return "global";
}
