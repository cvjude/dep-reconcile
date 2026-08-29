// Deterministic fixture generator.
//
// Builds a synthetic multi-project workspace under eval/fixtures/workspace/ with
// KNOWN seeded discrepancies and tricky decoys, plus an answer key (expected.json).
// Committing a generator (not binary node_modules) keeps the eval reproducible:
// `pnpm gen-fixtures` recreates the exact same workspace every time.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "workspace");

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}
function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

interface PkgOpts {
  postinstall?: boolean;
  native?: boolean;
  /** Body content — identical bodies across projects produce identical hashes. */
  body?: string;
  bin?: string;
}

/** Write a fake installed package into a project's node_modules. */
function writeInstalledPkg(projectRoot: string, name: string, version: string, opts: PkgOpts = {}) {
  const dir = join(projectRoot, "node_modules", name);
  const pj: Record<string, unknown> = { name, version, main: "index.js" };
  if (opts.postinstall) pj.scripts = { postinstall: "node ./install.js" };
  if (opts.bin) pj.bin = { [opts.bin]: "cli.js" };
  writeJson(join(dir, "package.json"), pj);
  writeText(join(dir, "index.js"), opts.body ?? `module.exports = ${JSON.stringify(name)};\n`);
  if (opts.postinstall) writeText(join(dir, "install.js"), "console.log('installing');\n");
  if (opts.native) writeText(join(dir, "build", "Release", "addon.node"), "\0FAKE-NATIVE\0");
  if (opts.bin) writeText(join(dir, "cli.js"), "#!/usr/bin/env node\nconsole.log('cli');\n");
}

interface ProjectSpec {
  name: string;
  deps: Record<string, string>; // declared ranges
  devDeps?: Record<string, string>;
  scripts?: Record<string, string>;
  eslintPlugins?: string[]; // referenced only in .eslintrc
  installed: { name: string; version: string; opts?: PkgOpts }[];
  locked: Record<string, string>; // name -> version in lockfile
  sourceTs: string; // src/index.ts contents
}

function writeProject(spec: ProjectSpec) {
  const root = join(WORKSPACE, spec.name);
  const pkg: Record<string, unknown> = {
    name: spec.name,
    version: "1.0.0",
    dependencies: spec.deps,
  };
  if (spec.devDeps) pkg.devDependencies = spec.devDeps;
  if (spec.scripts) pkg.scripts = spec.scripts;
  writeJson(join(root, "package.json"), pkg);

  // package-lock.json (v3 shape) with top-level packages entries.
  const packages: Record<string, { version: string }> = { "": { version: "1.0.0" } as never };
  for (const [name, version] of Object.entries(spec.locked)) {
    packages[`node_modules/${name}`] = { version };
  }
  writeJson(join(root, "package-lock.json"), { name: spec.name, lockfileVersion: 3, packages });

  // installed packages
  for (const inst of spec.installed) writeInstalledPkg(root, inst.name, inst.version, inst.opts);

  // eslint config referencing plugins (string-only usage)
  if (spec.eslintPlugins?.length) {
    writeJson(join(root, ".eslintrc.json"), { plugins: spec.eslintPlugins.map((p) => p.replace(/^eslint-plugin-/, "")), extends: spec.eslintPlugins });
  }

  // TypeScript source + tsconfig (so @types reasoning applies)
  writeText(join(root, "src", "index.ts"), spec.sourceTs);
  writeJson(join(root, "tsconfig.json"), { compilerOptions: { types: ["node"], strict: true }, include: ["src"] });
}

// Shared package bodies — identical strings => identical content hashes.
const LEFTPAD_BODY = "module.exports = function leftpad(s, n){ return String(s).padStart(n); };\n";
const ESBUILDISH_BODY = "module.exports = { build(){ return 'built'; } };\n";
const NATIVEMOD_BODY = "module.exports = require('./build/Release/addon.node');\n";

function build() {
  rmSync(WORKSPACE, { recursive: true, force: true });

  // ---- appA ----
  writeProject({
    name: "appA",
    deps: {
      realdep: "^1.0.0",
      ghostdep: "^1.0.0", // UNUSED (true positive #1)
      driftdep: "^1.0.0", // used, but drift (true positive #3)
      rimrafish: "^1.0.0", // decoy: used in script (#6)
      "eslint-plugin-fake": "^1.0.0", // decoy: used in config (#7)
      "@types/node": "^20.0.0", // decoy: type-only in TS project (#8)
      leftpad: "^1.0.0", // shared safe (link #5)
      esbuildish: "^0.1.0", // shared UNSAFE postinstall (#10)
    },
    scripts: { clean: "rimrafish dist" },
    eslintPlugins: ["eslint-plugin-fake"],
    locked: {
      realdep: "1.0.0",
      ghostdep: "1.0.0",
      driftdep: "1.0.0", // locked 1.0.0 ...
      rimrafish: "1.0.0",
      "eslint-plugin-fake": "1.0.0",
      "@types/node": "20.0.0",
      leftpad: "1.0.0",
      esbuildish: "0.1.0",
    },
    installed: [
      { name: "realdep", version: "1.0.0" },
      { name: "ghostdep", version: "1.0.0" },
      { name: "driftdep", version: "1.2.0" }, // ...but installed 1.2.0 => DRIFT
      { name: "rimrafish", version: "1.0.0", opts: { bin: "rimrafish" } },
      { name: "eslint-plugin-fake", version: "1.0.0" },
      { name: "@types/node", version: "20.0.0" },
      { name: "leftpad", version: "1.0.0", opts: { body: LEFTPAD_BODY } },
      { name: "esbuildish", version: "0.1.0", opts: { postinstall: true, body: ESBUILDISH_BODY } },
    ],
    sourceTs: [
      `import realdep from "realdep";`,
      `import driftdep from "driftdep";`,
      `import leftpad from "leftpad";`,
      `import esbuildish from "esbuildish";`,
      `import phantomdep from "phantomdep";`, // PHANTOM (true positive #2)
      `export const x = [realdep, driftdep, leftpad, esbuildish, phantomdep];`,
    ].join("\n") + "\n",
  });

  // ---- appB ----
  writeProject({
    name: "appB",
    deps: {
      realdep: "^1.0.0",
      deadmoment: "^2.0.0", // UNUSED (true positive #4)
      dyndep: "^1.0.0", // decoy: used via dynamic require (#9)
      leftpad: "^1.0.0", // shared safe (link #5)
      esbuildish: "^0.1.0", // shared UNSAFE postinstall (#10)
      nativemod: "^2.0.0", // shared UNSAFE native (#11)
    },
    locked: {
      realdep: "1.0.0",
      deadmoment: "2.0.0",
      dyndep: "1.0.0",
      leftpad: "1.0.0",
      esbuildish: "0.1.0",
      nativemod: "2.0.0",
    },
    installed: [
      { name: "realdep", version: "1.0.0" },
      { name: "deadmoment", version: "2.0.0" },
      { name: "dyndep", version: "1.0.0" },
      { name: "leftpad", version: "1.0.0", opts: { body: LEFTPAD_BODY } },
      { name: "esbuildish", version: "0.1.0", opts: { postinstall: true, body: ESBUILDISH_BODY } },
      { name: "nativemod", version: "2.0.0", opts: { native: true, body: NATIVEMOD_BODY } },
    ],
    sourceTs: [
      `import realdep from "realdep";`,
      `import esbuildish from "esbuildish";`,
      `import nativemod from "nativemod";`,
      `const e = require("dyndep");`, // string dynamic require -> dyndep is used
      `import("leftpad").then(() => {});`, // dynamic import of shared pkg
      `export const y = [realdep, esbuildish, nativemod, e];`,
    ].join("\n") + "\n",
  });

  // ---- appC ----
  writeProject({
    name: "appC",
    deps: {
      realdep: "^1.0.0",
      unusedchalk: "^5.0.0", // UNUSED (true positive #12)
      leftpad: "^1.0.0", // shared safe (link #5)
      nativemod: "^2.0.0", // shared UNSAFE native (#11)
    },
    locked: { realdep: "1.0.0", unusedchalk: "5.0.0", leftpad: "1.0.0", nativemod: "2.0.0" },
    installed: [
      { name: "realdep", version: "1.0.0" },
      { name: "unusedchalk", version: "5.0.0" },
      { name: "leftpad", version: "1.0.0", opts: { body: LEFTPAD_BODY } },
      { name: "nativemod", version: "2.0.0", opts: { native: true, body: NATIVEMOD_BODY } },
    ],
    sourceTs: [
      `import realdep from "realdep";`,
      `import leftpad from "leftpad";`,
      `import nativemod from "nativemod";`,
      `export const z = [realdep, leftpad, nativemod];`,
    ].join("\n") + "\n",
  });

  // ---- Answer key ----
  const expected = {
    unused: [
      { project: "appA", pkg: "ghostdep" },
      { project: "appB", pkg: "deadmoment" },
      { project: "appC", pkg: "unusedchalk" },
    ],
    phantom: [{ project: "appA", pkg: "phantomdep" }],
    versionDrift: [{ project: "appA", pkg: "driftdep", locked: "1.0.0", installed: "1.2.0" }],
    // Decoys: must NOT be reported as unused.
    notUnused: [
      { project: "appA", pkg: "rimrafish", why: "used in npm script" },
      { project: "appA", pkg: "eslint-plugin-fake", why: "used in eslint config" },
      { project: "appA", pkg: "@types/node", why: "type-only in TS project" },
      { project: "appB", pkg: "dyndep", why: "used via dynamic require" },
    ],
    safeToLink: [
      { key: "leftpad@1.0.0", projects: ["appA", "appB", "appC"] },
      { key: "realdep@1.0.0", projects: ["appA", "appB", "appC"] },
    ],
    unsafeToLink: [
      { key: "esbuildish@0.1.0", why: "postinstall script" },
      { key: "nativemod@2.0.0", why: "native binary" },
    ],
  };
  writeJson(join(WORKSPACE, "expected.json"), expected);

  const totalCases =
    expected.unused.length +
    expected.phantom.length +
    expected.versionDrift.length +
    expected.notUnused.length +
    expected.safeToLink.length +
    expected.unsafeToLink.length;
  console.log(`Generated workspace at ${WORKSPACE}`);
  console.log(`Projects: appA, appB, appC — ${totalCases} labeled cases in expected.json`);
}

build();
