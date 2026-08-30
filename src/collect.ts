import type { ProjectEvidence, SafetyFacts } from "./types.js";
import { readManifest, usageFromScripts } from "./analyzers/manifest.js";
import { readLockfile } from "./analyzers/lockfile.js";
import { scanInstalled } from "./analyzers/installed.js";
import { scanImports } from "./analyzers/imports.js";
import { hasTypeScript, scanConfigUsage } from "./analyzers/usage.js";
import { hashPackage, patchedPackages, probeSafety } from "./analyzers/safety.js";

/**
 * Run every deterministic analyzer over a single project and assemble the full
 * evidence bundle. This does NOT decide anything — it only gathers facts for the
 * agent (and for the deterministic baseline) to reason about.
 */
export function collectProject(projectDir: string, options: { probeSafety?: boolean } = {}): ProjectEvidence {
  const manifest = readManifest(projectDir);
  const declaredNames = manifest.declared.map((d) => d.name);

  const locked = readLockfile(projectDir);
  const installedPkgs = scanInstalled(projectDir);
  const imports = scanImports(projectDir);

  const usageSignals = [
    ...usageFromScripts(manifest, new Set(declaredNames)),
    ...scanConfigUsage(projectDir, declaredNames, manifest.raw),
  ];

  const installed: Record<string, string> = {};
  const installedSizes: Record<string, number> = {};
  for (const p of installedPkgs) {
    installed[p.name] = p.version;
    installedSizes[`${p.name}@${p.version}`] = p.bytes;
  }

  let safety: SafetyFacts[] = [];
  if (options.probeSafety !== false) {
    const patched = patchedPackages(projectDir);
    safety = installedPkgs.map((p) => probeSafety(p, patched));
  }

  return {
    projectDir,
    name: manifest.name,
    declared: manifest.declared,
    locked,
    installed,
    imports,
    usageSignals,
    safety,
    installedSizes,
    hasTypeScript: hasTypeScript(projectDir),
  };
}

export interface CollectProgress {
  onProject?: (index: number, total: number, name: string) => void;
  onHash?: (done: number, total: number) => void;
}

/**
 * Collect several projects, then fill content hashes ONLY for packages whose
 * name@version appears in two or more projects (the only ones that could be
 * cross-project duplicates). Packages unique to a single project are never
 * hashed, which is what makes a whole-machine scan fast.
 */
export function collectWorkspace(projectDirs: string[], progress: CollectProgress = {}): ProjectEvidence[] {
  const evidences = projectDirs.map((dir, i) => {
    progress.onProject?.(i, projectDirs.length, dir);
    return collectProject(dir);
  });

  // Count how many projects hold each name@version.
  const copies = new Map<string, number>();
  for (const ev of evidences) {
    for (const s of ev.safety) {
      const key = `${s.name}@${s.version}`;
      copies.set(key, (copies.get(key) ?? 0) + 1);
    }
  }

  // Hash only the packages that could be shared (>= 2 copies across projects).
  const toHash: SafetyFacts[] = [];
  for (const ev of evidences) {
    for (const s of ev.safety) {
      if ((copies.get(`${s.name}@${s.version}`) ?? 0) >= 2) toHash.push(s);
    }
  }
  let done = 0;
  for (const s of toHash) {
    s.contentHash = hashPackage(s.path);
    progress.onHash?.(++done, toHash.length);
  }

  return evidences;
}
