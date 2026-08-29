import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { dirSize } from "../util.js";

export interface InstalledPkg {
  name: string;
  version: string;
  path: string;
  bytes: number;
}

function readVersion(pkgDir: string): string | null {
  try {
    const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: string };
    return pj.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Enumerate the top-level installed packages in a project's node_modules,
 * resolving each one's real version (from its own package.json) and on-disk size.
 */
export function scanInstalled(projectDir: string): InstalledPkg[] {
  const nm = join(projectDir, "node_modules");
  if (!existsSync(nm)) return [];
  const out: InstalledPkg[] = [];

  const entries = readdirSync(nm, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .bin, .package-lock.json, .cache
    if (e.name.startsWith("@")) {
      // Scoped: descend one level.
      const scopeDir = join(nm, e.name);
      let scoped: Dirent[];
      try {
        scoped = readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (!s.isDirectory()) continue;
        const full = join(scopeDir, s.name);
        const version = readVersion(full);
        if (version) out.push({ name: `${e.name}/${s.name}`, version, path: full, bytes: dirSize(full) });
      }
    } else if (e.isDirectory()) {
      const full = join(nm, e.name);
      const version = readVersion(full);
      if (version) out.push({ name: e.name, version, path: full, bytes: dirSize(full) });
    }
  }
  return out;
}
