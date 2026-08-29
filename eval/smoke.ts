import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectProject } from "../src/collect.js";
import { generateCandidates, generateLinkCandidates } from "../src/reconcile.js";
import { fmtBytes } from "../src/util.js";
import type { ProjectEvidence } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "fixtures", "workspace");

const projects = ["appA", "appB", "appC"];
const evidences: ProjectEvidence[] = [];

for (const p of projects) {
  const ev = collectProject(join(WORKSPACE, p));
  evidences.push(ev);
  console.log(`\n=== ${p} ===`);
  const cands = generateCandidates(ev);
  for (const c of cands) {
    console.log(`  [${c.kind}] ${c.pkg}${c.reclaimBytes ? ` (${fmtBytes(c.reclaimBytes)})` : ""}`);
    for (const e of c.evidence) console.log(`      · ${e}`);
  }
}

console.log(`\n=== cross-project link candidates ===`);
for (const l of generateLinkCandidates(evidences)) {
  console.log(`  ${l.key}  copies=${l.copies.length}  reclaim=${fmtBytes(l.reclaimBytes)}  safe=${l.safe}`);
  console.log(`      · ${l.safetyReason}`);
}
