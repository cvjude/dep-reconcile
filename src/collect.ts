import type { ProjectEvidence, SafetyFacts } from "./types.js";
import { readManifest, usageFromScripts } from "./analyzers/manifest.js";
import { readLockfile } from "./analyzers/lockfile.js";
import { scanInstalled } from "./analyzers/installed.js";
import { scanImports } from "./analyzers/imports.js";
import { hasTypeScript, scanConfigUsage } from "./analyzers/usage.js";
import { patchedPackages, probeSafety } from "./analyzers/safety.js";

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
