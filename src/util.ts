import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * Resolve the bare package name an import specifier refers to.
 * Returns null for relative paths, absolute paths, and Node built-ins.
 *
 *   "lodash"            -> "lodash"
 *   "lodash/fp"         -> "lodash"
 *   "@scope/pkg/sub"    -> "@scope/pkg"
 *   "node:fs" / "fs"    -> null (built-in)
 *   "./local"           -> null
 */
export function pkgNameFromSpecifier(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  let name: string;
  if (spec.startsWith("@")) {
    if (parts.length < 2) return null;
    name = `${parts[0]}/${parts[1]}`;
  } else {
    name = parts[0];
  }
  if (BUILTINS.has(name)) return null;
  return name;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo"]);
const SOURCE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/** Recursively list source files in a project, skipping build/vendor dirs. */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0 && SOURCE_EXT.has(e.name.slice(dot))) out.push(join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** Total size in bytes of a directory tree (follows no symlinks). */
export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += statSync(p).size;
      } catch {
        // unreadable entry — skip
      }
    }
  };
  walk(dir);
  return total;
}

/** Format bytes as a human-readable string. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
