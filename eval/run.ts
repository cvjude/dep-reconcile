import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkspace } from "../src/collect.js";
import { generateLinkCandidates } from "../src/reconcile.js";
import { runNaive } from "../src/tools/naive.js";
import { runPrompt } from "../src/tools/prompt.js";
import { runAgent } from "../src/agent/agent.js";
import { usage } from "../src/agent/llm.js";
import { fmtBytes } from "../src/util.js";
import type { ProjectEvidence, ToolOutput } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "fixtures", "workspace");
const OUT = join(HERE, "..", "out");

interface Expected {
  unused: { project: string; pkg: string }[];
  phantom: { project: string; pkg: string }[];
  versionDrift: { project: string; pkg: string }[];
  notUnused: { project: string; pkg: string; why: string }[];
  safeToLink: { key: string; projects: string[] }[];
  unsafeToLink: { key: string; why: string }[];
}

type Row = { project: string; pkg: string };
const keyOf = (r: Row) => `${r.project}/${r.pkg}`;

function score(reported: Row[], expected: Row[]) {
  const exp = new Set(expected.map(keyOf));
  const rep = new Set(reported.map(keyOf));
  const tp = [...rep].filter((k) => exp.has(k)).length;
  const fp = [...rep].filter((k) => !exp.has(k)).length;
  const fn = [...exp].filter((k) => !rep.has(k)).length;
  return { tp, fp, fn };
}

function prf({ tp, fp, fn }: { tp: number; fp: number; fn: number }) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}

async function runTool(name: string, evidences: ProjectEvidence[]): Promise<ToolOutput> {
  if (name === "naive") return runNaive(evidences);
  if (name === "prompt") return runPrompt(evidences);
  if (name === "agent") return runAgent(evidences);
  throw new Error(`unknown tool: ${name}`);
}

function evaluate(name: string, out: ToolOutput, expected: Expected, evidences: ProjectEvidence[]) {
  const unused = score(out.unused, expected.unused);
  const phantom = score(out.phantom, expected.phantom);
  const drift = score(out.drift, expected.versionDrift);

  const expSafe = new Set(expected.safeToLink.map((s) => s.key));
  const expUnsafe = new Set(expected.unsafeToLink.map((s) => s.key));
  const reportedLinks = new Set(out.linkedGroups);
  const linkTp = [...reportedLinks].filter((k) => expSafe.has(k)).length;
  const linkFp = [...reportedLinks].filter((k) => !expSafe.has(k)).length;
  const linkFn = [...expSafe].filter((k) => !reportedLinks.has(k)).length;
  const brokenLinks = [...reportedLinks].filter((k) => expUnsafe.has(k));

  // Aggregate correctness across all discrepancy types + safe links.
  const agg = {
    tp: unused.tp + phantom.tp + drift.tp + linkTp,
    fp: unused.fp + phantom.fp + drift.fp + linkFp,
    fn: unused.fn + phantom.fn + drift.fn + linkFn,
  };

  // Disk math.
  const linkBytes = generateLinkCandidates(evidences);
  const linkSize = new Map(linkBytes.map((l) => [l.key, l.reclaimBytes]));
  const sizeByProjPkg = new Map<string, number>();
  for (const ev of evidences)
    for (const [k, b] of Object.entries(ev.installedSizes)) {
      const nm = k.slice(0, k.lastIndexOf("@"));
      sizeByProjPkg.set(`${ev.name}/${nm}`, b);
    }
  const unusedBytes = out.unused.reduce((s, r) => s + (sizeByProjPkg.get(keyOf(r)) ?? 0), 0);
  const reclaimedBytes = out.linkedGroups.reduce((s, k) => s + (linkSize.get(k) ?? 0), 0) + unusedBytes;

  return {
    name,
    unused: prf(unused),
    phantom: prf(phantom),
    drift: prf(drift),
    links: { ...prf({ tp: linkTp, fp: linkFp, fn: linkFn }), brokenLinks },
    overall: prf(agg),
    agg,
    reclaimedBytes,
    projectsBroken: brokenLinks.length,
  };
}

async function main() {
  const toolArg = process.argv[process.argv.indexOf("--tool") + 1] ?? "all";
  const tools = toolArg === "all" ? ["naive", "prompt", "agent"] : [toolArg];

  const evidences = collectWorkspace(["appA", "appB", "appC"].map((p) => join(WORKSPACE, p)));
  const expected = JSON.parse(readFileSync(join(WORKSPACE, "expected.json"), "utf8")) as Expected;

  mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const t of tools) {
    process.stderr.write(`running ${t}...\n`);
    const out = await runTool(t, evidences);
    const r = evaluate(t, out, expected, evidences);
    results.push(r);
    writeFileSync(join(OUT, `eval-${t}.json`), JSON.stringify({ output: out, score: r }, null, 2));
  }

  // Report
  console.log(`\n  TOOL     unused-F1  phantom-F1  drift-F1  link-F1  overall-F1  broken  reclaim`);
  console.log(`  ${"-".repeat(78)}`);
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(8)} ${pct(r.unused.f1).padStart(8)}  ${pct(r.phantom.f1).padStart(9)}  ` +
        `${pct(r.drift.f1).padStart(7)}  ${pct(r.links.f1).padStart(6)}  ${pct(r.overall.f1).padStart(9)}  ` +
        `${String(r.projectsBroken).padStart(6)}  ${fmtBytes(r.reclaimedBytes).padStart(8)}`,
    );
  }
  console.log("");
  for (const r of results) {
    console.log(
      `  ${r.name}: precision ${pct(r.overall.precision)}, recall ${pct(r.overall.recall)} ` +
        `(tp=${r.agg.tp} fp=${r.agg.fp} fn=${r.agg.fn})` +
        (r.links.brokenLinks.length ? `  ⚠ would break: ${r.links.brokenLinks.join(", ")}` : ""),
    );
  }
  const u = usage();
  if (u.calls > 0)
    console.log(`\n  LLM: ${u.calls} calls, ${u.tokensIn} in / ${u.tokensOut} out tokens (${u.model})`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
