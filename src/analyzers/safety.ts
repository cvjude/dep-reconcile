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

/** Walk a package dir; report native artifacts and build a content hash. */
function probeTree(pkgDir: string): { hasNative: boolean; contentHash: string } {
  const files: { rel: string; size: number; sha: string }[] = [];
  let hasNative = false;

  const walk = (dir: string, prefix: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // A nested node_modules belongs to the package's own deps; skip for identity.
        if (e.name === "node_modules") continue;
        walk(full, rel);
      } else if (e.isFile()) {
        if (e.name.endsWith(".node") || e.name === "binding.gyp") hasNative = true;
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
  return { hasNative, contentHash: h.digest("hex") };
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

/** Produce safety facts for one installed package. */
export function probeSafety(pkg: InstalledPkg, patched: Set<string>): SafetyFacts {
  const scripts = readScripts(pkg.path);
  const hasInstallScript = INSTALL_HOOKS.some((h) => scripts[h]);
  const { hasNative, contentHash } = probeTree(pkg.path);
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
