import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { SafetyFacts } from "../types.js";
import type { InstalledPkg } from "./installed.js";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

function readScripts(pkgDir: string): Record<string, string> {
  try {
    const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pj.scripts ?? {};
  } catch {
    return {};
  }
}

/** Cheap walk: detect native artifacts by filename only (no file reads). */
function detectNative(pkgDir: string): boolean {
  let found = false;
  const walk = (dir: string) => {
    if (found) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(join(dir, e.name));
      } else if (e.name.endsWith(".node") || e.name === "binding.gyp") {
        found = true;
        return;
      }
    }
  };
  walk(pkgDir);
  return found;
}

/**
 * Expensive walk: read every file and build a content hash proving byte identity.
 * Only called for packages that could be cross-project duplicates, never for the
 * many packages unique to a single project.
 */
export function hashPackage(pkgDir: string): string {
  const files: { rel: string; size: number; sha: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(full, rel);
      } else if (e.isFile()) {
        try {
          const buf = readFileSync(full);
          files.push({ rel, size: statSync(full).size, sha: createHash("sha1").update(buf).digest("hex") });
        } catch {
          // unreadable — omit from hash
        }
      }
    }
  };
  walk(pkgDir, "");

  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}:${f.size}:${f.sha}\n`);
  return h.digest("hex");
}

/**
 * A project is "patched" for a package when patch-package has a matching patch
 * file. Such packages must never be shared across projects — the patch makes
 * this project's copy intentionally different.
 */
export function patchedPackages(projectDir: string): Set<string> {
  const out = new Set<string>();
  const patchesDir = join(projectDir, "patches");
  if (!existsSync(patchesDir)) return out;
  try {
    for (const f of readdirSync(patchesDir)) {
      // Convention: "<name>+<version>.patch" or "@scope+name+version.patch".
      const base = f.replace(/\.patch$/, "");
      const name = base.startsWith("@")
        ? base.replace(/^@/, "@").split("+").slice(0, 2).join("/").replace(/\/(\d.*)$/, "")
        : base.split("+")[0];
      if (name) out.add(name);
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Produce the CHEAP safety facts for one installed package (no content hash).
 * `contentHash` is left empty and filled in later only for dedup candidates.
 */
export function probeSafety(pkg: InstalledPkg, patched: Set<string>): SafetyFacts {
  const scripts = readScripts(pkg.path);
  const hasInstallScript = INSTALL_HOOKS.some((h) => scripts[h]);
  const hasNative = detectNative(pkg.path);
  const contentHash = "";
  const isPatched = patched.has(pkg.name);

  const riskNotes: string[] = [];
  if (hasInstallScript) riskNotes.push(`has install hook(s): ${INSTALL_HOOKS.filter((h) => scripts[h]).join(", ")}`);
  if (hasNative) riskNotes.push("contains native binary (.node/binding.gyp)");
  if (isPatched) riskNotes.push("patched via patch-package in this project");

  return {
    name: pkg.name,
    version: pkg.version,
    path: pkg.path,
    hasInstallScript,
    hasNativeBinary: hasNative,
    isPatched,
    contentHash,
    riskNotes,
  };
}
