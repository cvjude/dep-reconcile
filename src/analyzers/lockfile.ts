import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse package-lock.json (v2/v3 "packages", falling back to v1 "dependencies")
 * into a flat map of top-level package name -> resolved version.
 *
 * We only take top-level entries (a single "node_modules/<name>" segment), which
 * represents what the project resolves at the root of its tree.
 */
export function readLockfile(projectDir: string): Record<string, string> {
  const lockPath = join(projectDir, "package-lock.json");
  if (!existsSync(lockPath)) return {};
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string }>;
  };

  const out: Record<string, string> = {};

  if (lock.packages) {
    // v2/v3: keys look like "node_modules/lodash" or
    // "node_modules/@scope/pkg" (top level) and deeper nested paths.
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key.startsWith("node_modules/")) continue;
      const rest = key.slice("node_modules/".length);
      // Reject nested entries (they contain a further "/node_modules/").
      if (rest.includes("/node_modules/")) continue;
      const isScoped = rest.startsWith("@");
      const segments = rest.split("/");
      const isTopLevel = isScoped ? segments.length === 2 : segments.length === 1;
      if (isTopLevel && meta.version) out[rest] = meta.version;
    }
    return out;
  }

  if (lock.dependencies) {
    // v1 fallback: top-level dependencies map.
    for (const [name, meta] of Object.entries(lock.dependencies)) {
      if (meta.version) out[name] = meta.version;
    }
  }

  return out;
}
