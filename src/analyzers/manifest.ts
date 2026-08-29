import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeclaredDep, UsageSignal } from "../types.js";

export interface Manifest {
  name: string;
  declared: DeclaredDep[];
  scripts: Record<string, string>;
  raw: Record<string, unknown>;
}

function collect(
  deps: Record<string, string> | undefined,
  kind: DeclaredDep["kind"],
): DeclaredDep[] {
  if (!deps) return [];
  return Object.entries(deps).map(([name, range]) => ({ name, range, kind }));
}

/** Parse a project's package.json into declared deps + scripts. */
export function readManifest(projectDir: string): Manifest {
  const raw = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const declared: DeclaredDep[] = [
    ...collect(raw.dependencies as Record<string, string>, "prod"),
    ...collect(raw.devDependencies as Record<string, string>, "dev"),
    ...collect(raw.peerDependencies as Record<string, string>, "peer"),
    ...collect(raw.optionalDependencies as Record<string, string>, "optional"),
  ];
  return {
    name: (raw.name as string) ?? projectDir,
    declared,
    scripts: (raw.scripts as Record<string, string>) ?? {},
    raw,
  };
}

/**
 * A dependency can be "used" without being imported: invoked as a CLI binary
 * inside an npm script. We detect a script token that matches a declared
 * package name (or its bin). This is a key false-positive guard for "unused".
 */
export function usageFromScripts(manifest: Manifest, declaredNames: Set<string>): UsageSignal[] {
  const signals: UsageSignal[] = [];
  for (const [scriptName, body] of Object.entries(manifest.scripts)) {
    // Split on shell separators to get command tokens.
    const tokens = body.split(/[\s|&;()><]+/).filter(Boolean);
    for (const tok of tokens) {
      // A bin invocation is usually the unscoped last path segment of a pkg,
      // e.g. "rimraf", "tsc", "eslint". Match against declared names and the
      // last segment of scoped names.
      for (const name of declaredNames) {
        const bin = name.startsWith("@") ? name.split("/")[1] : name;
        if (tok === name || tok === bin) {
          signals.push({
            pkg: name,
            where: `script:${scriptName}`,
            detail: `"${scriptName}": "${body}"`,
          });
        }
      }
    }
  }
  return signals;
}
