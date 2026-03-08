/**
 * Scope detection — maps cwd or Obsidian paths to project scopes.
 * Loads scope map from ~/.unified-memory/config.json if available,
 * falls back to built-in defaults.
 */
import fs from "node:fs";
import path from "node:path";

/** Default cwd → scope mapping */
const DEFAULT_SCOPE_MAP: Record<string, string> = {
  "todait-backend": "/workspace/todait/todait/todait-backend",
  "todait-ios": "/workspace/todait/todait/todait-ios",
  "data-pipeline": "/Projects/data-pipeline",
  "scrumble-backend": "/Projects/scrumble-backend",
  blog: "/Projects/flowkater.io",
  openclaw: "/.openclaw",
  mentoring: "/Obsidian/flowkater/flowkater/Mentoring",
};

/** Default Obsidian relative path → scope mapping */
const DEFAULT_OBSIDIAN_SCOPE_MAP: Record<string, string> = {
  "Project/todait-backend-v2/": "todait-backend",
  "Project/todait-ios/": "todait-ios",
  "Project/data-pipeline/": "data-pipeline",
  "Project/Todait/": "todait",
  "Mentoring/": "mentoring",
  "Blog/": "blog",
  "Study/": "study",
  "Daily/": "daily",
  "투데잇/": "todait",
  "_ontology/": "ontology",
};

interface ScopeConfig {
  scopeMap?: Record<string, string>;
  obsidianScopeMap?: Record<string, string>;
}

// Config is cached for the lifetime of the process.
// Changes to ~/.unified-memory/config.json require a server restart to take effect.
let _cachedConfig: ScopeConfig | null = null;

/**
 * Load scope configuration from ~/.unified-memory/config.json.
 * Returns defaults if config file doesn't exist or is invalid.
 */
function loadConfig(): ScopeConfig {
  if (_cachedConfig) return _cachedConfig;

  const configPath = path.join(
    process.env.HOME || "~",
    ".unified-memory",
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
