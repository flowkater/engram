/**
 * Scope detection — maps cwd or Obsidian paths to project scopes.
 */

/** cwd → scope mapping */
const SCOPE_MAP: Record<string, string> = {
  "todait-backend": "/workspace/todait/todait/todait-backend",
  "todait-ios": "/workspace/todait/todait/todait-ios",
  "data-pipeline": "/Projects/data-pipeline",
  "scrumble-backend": "/Projects/scrumble-backend",
  blog: "/Projects/flowkater.io",
  openclaw: "/.openclaw",
  mentoring: "/Obsidian/flowkater/flowkater/Mentoring",
};

/** Obsidian relative path → scope mapping */
const OBSIDIAN_SCOPE_MAP: Record<string, string> = {
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

/**
 * Detect scope from a working directory path.
 */
export function detectScope(cwd: string): string {
  for (const [scope, pathFragment] of Object.entries(SCOPE_MAP)) {
    if (cwd.includes(pathFragment)) return scope;
  }
  return "global";
}

/**
 * Detect scope from an Obsidian vault-relative file path.
 */
export function detectObsidianScope(relativePath: string): string {
  for (const [prefix, scope] of Object.entries(OBSIDIAN_SCOPE_MAP)) {
    if (relativePath.startsWith(prefix)) return scope;
  }
  return "global";
}
