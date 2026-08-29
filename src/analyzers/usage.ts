import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { UsageSignal } from "../types.js";

// Config files commonly reference packages by *string* (eslint plugins, babel
// presets, jest transforms, tsconfig types). A dep used only here is NOT unused
// — this scanner is the primary false-positive guard for the "unused" verdict.
const CONFIG_PATTERNS = [
  /^\.eslintrc(\.(js|cjs|mjs|json|yml|yaml))?$/,
  /^eslint\.config\.(js|cjs|mjs|ts)$/,
  /^\.prettierrc(\.(js|cjs|mjs|json|yml|yaml))?$/,
  /^prettier\.config\.(js|cjs|mjs)$/,
  /^(jest|vitest|vite|rollup|webpack|tailwind|postcss|nodemon)\.config\.(js|cjs|mjs|ts|json)$/,
  /^babel\.config\.(js|cjs|mjs|json)$/,
  /^\.babelrc(\.(js|cjs|mjs|json))?$/,
  /^\.mocharc\.(js|cjs|json|yml|yaml)$/,
  /^tsconfig(\.\w+)?\.json$/,
  /^\.commitlintrc(\.(js|cjs|json))?$/,
  /^\.lintstagedrc(\.(js|cjs|json))?$/,
];

// package.json sub-fields that embed tool config (and thus package references).
const INLINE_CONFIG_FIELDS = ["eslintConfig", "jest", "babel", "prettier", "husky", "lint-staged", "nodemonConfig"];

function configFiles(projectDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(projectDir).filter((n) => CONFIG_PATTERNS.some((re) => re.test(n)));
  } catch {
    names = [];
  }
  return names.map((n) => join(projectDir, n));
}

/**
 * For each declared package, look for its name as a token in any config file or
 * inline config field. Emits a UsageSignal per hit so the agent can weigh it.
 */
export function scanConfigUsage(
  projectDir: string,
  declaredNames: string[],
  manifestRaw: Record<string, unknown>,
): UsageSignal[] {
  const signals: UsageSignal[] = [];

  const blobs: { where: string; text: string }[] = [];
  for (const f of configFiles(projectDir)) {
    try {
      blobs.push({ where: `config:${f.slice(projectDir.length + 1)}`, text: readFileSync(f, "utf8") });
    } catch {
      // unreadable — skip
    }
  }
  for (const field of INLINE_CONFIG_FIELDS) {
    if (manifestRaw[field] !== undefined) {
      blobs.push({ where: `package.json#${field}`, text: JSON.stringify(manifestRaw[field]) });
    }
  }
  // tsconfig "types" often names @types packages implicitly used by tsc.

  for (const name of declaredNames) {
    // Word-bounded match to avoid "react" matching "react-dom", etc.
    const re = new RegExp(`(^|["'\\s/])${escapeRe(name)}(["'\\s/]|$)`);
    for (const blob of blobs) {
      if (re.test(blob.text)) {
        const idx = blob.text.indexOf(name);
        const snippet = blob.text.slice(Math.max(0, idx - 20), idx + name.length + 20).replace(/\s+/g, " ");
        signals.push({ pkg: name, where: blob.where, detail: `…${snippet}…` });
      }
    }
  }
  return signals;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detect whether the project contains any TypeScript source (affects @types/* judgement). */
export function hasTypeScript(projectDir: string): boolean {
  const walk = (dir: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (walk(join(dir, e.name))) return true;
      } else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) {
        return true;
      }
    }
    return false;
  };
  return existsSync(join(projectDir, "tsconfig.json")) || walk(projectDir);
}
