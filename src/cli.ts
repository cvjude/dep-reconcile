import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectProject } from "./collect.js";
import { generateCandidates, generateLinkCandidates } from "./reconcile.js";
import { analyzeWithAgent, type AgentResult } from "./agent/agent.js";
import { detectCaches } from "./analyzers/cache.js";
import { buildPlan } from "./plan.js";
import { applyLinks, writeJournal, undo } from "./apply/link.js";
import { usage } from "./agent/llm.js";
import { fmtBytes } from "./util.js";
import type { ProjectEvidence } from "./types.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Expand a path into project dirs (a dir with package.json, or its children). */
function resolveProjects(paths: string[]): string[] {
  const projects: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (existsSync(join(abs, "package.json"))) {
      projects.push(abs);
      continue;
    }
    // Otherwise treat as a parent: find immediate children that are projects.
    try {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(abs, e.name, "package.json"))) projects.push(join(abs, e.name));
      }
    } catch {
      // skip unreadable
    }
  }
  return projects;
}

/** Build an AgentResult without the LLM (deterministic fallback). */
function deterministicResult(evidences: ProjectEvidence[]): AgentResult {
  const unused = [];
  const phantom = [];
  const drift = [];
  for (const ev of evidences) {
    for (const c of generateCandidates(ev)) {
      if (c.kind === "unused") unused.push({ ...c, verdict: "uncertain" as const, reason: "not verified (deterministic mode)" });
      else if (c.kind === "phantom") phantom.push({ ...c, verdict: "uncertain" as const, reason: "not verified (deterministic mode)" });
      else drift.push(c);
    }
  }
  return { unused, phantom, drift, links: generateLinkCandidates(evidences) };
}

function printPlan(plan: ReturnType<typeof buildPlan>) {
  const line = (s = "") => process.stdout.write(s + "\n");

  line(`\n  dep-reconcile — reclamation plan\n  ${"=".repeat(52)}`);

  if (plan.caches.length) {
    line(`\n  CACHES  (safe, instant)`);
    for (const c of plan.caches) line(`    ${c.tool.padEnd(5)} ${fmtBytes(c.bytes).padStart(9)}   ${c.action}`);
    line(`    ${"—".repeat(40)}\n    subtotal: ${fmtBytes(plan.totals.cacheBytes)}`);
  }

  if (plan.unused.length) {
    line(`\n  UNUSED DEPENDENCIES  (verified removable)`);
    for (const u of plan.unused) {
      line(`    ${u.project}/${u.pkg}  ${fmtBytes(u.reclaimBytes ?? 0).padStart(8)}   ${u.fix ?? ""}`);
      line(`        └ ${u.reason}`);
    }
    line(`    subtotal: ${fmtBytes(plan.totals.unusedBytes)}`);
  }

  if (plan.drift.length) {
    line(`\n  VERSION DRIFT  (lockfile ≠ installed)`);
    for (const d of plan.drift) line(`    ${d.project}/${d.pkg}   ${d.drift?.locked} (locked) vs ${d.drift?.installed} (installed)`);
  }

  if (plan.phantom.length) {
    line(`\n  PHANTOM DEPENDENCIES  (undeclared; will break strict installs)`);
    for (const p of plan.phantom) line(`    ${p.project}/${p.pkg}   ${p.fix ?? ""}`);
  }

  const safe = plan.links.filter((l) => l.safe);
  const unsafe = plan.links.filter((l) => !l.safe);
  if (safe.length) {
    line(`\n  CROSS-PROJECT LINKS  (byte-identical, safe to share)`);
    for (const l of safe) line(`    ${l.key.padEnd(28)} ${l.copies.length} copies   reclaim ${fmtBytes(l.reclaimBytes)}`);
    line(`    subtotal: ${fmtBytes(plan.totals.linkBytes)}`);
  }
  if (unsafe.length) {
    line(`\n  SKIPPED — unsafe to link  (kept separate on purpose)`);
    for (const l of unsafe) line(`    ${l.key.padEnd(28)} ${l.safetyReason}`);
  }

  line(`\n  ${"=".repeat(52)}`);
  line(`  TOTAL RECLAIMABLE: ${fmtBytes(plan.totals.reclaimableBytes)}\n`);
}

async function analyze(projects: string[], useAgent: boolean) {
  const evidences = projects.map((p) => collectProject(p));
  const agent = useAgent ? await analyzeWithAgent(evidences) : deterministicResult(evidences);
  const caches = hasFlag("no-caches") ? [] : detectCaches();
  return { evidences, plan: buildPlan(agent, caches) };
}

async function main() {
  const cmd = process.argv[2];
  const positionals = process.argv.slice(3).filter((a) => !a.startsWith("--"));

  if (cmd === "undo") {
    const jp = positionals[0] ?? flagValue("journal");
    if (!jp) return fail("usage: dep-reconcile undo <journal.json>");
    const r = undo(resolve(jp));
    console.log(`Restored ${r.restored} file(s) to independent copies (${r.failed} failed).`);
    return;
  }

  if (cmd !== "scan" && cmd !== "apply") {
    return fail("usage: dep-reconcile <scan|apply|undo> <paths...> [--deterministic] [--no-caches] [--yes] [--journal <path>]");
  }

  const projects = resolveProjects(positionals.length ? positionals : ["."]);
  if (!projects.length) return fail("no projects found (need a dir with package.json)");

  const useAgent = !hasFlag("deterministic") && !!process.env.ANTHROPIC_API_KEY;
  if (!useAgent && !hasFlag("deterministic")) {
    console.warn("  ! ANTHROPIC_API_KEY not set — running deterministic (unverified) mode.\n");
  }

  const { plan } = await analyze(projects, useAgent);
  printPlan(plan);

  const u = usage();
  if (u.calls) console.log(`  (agent: ${u.calls} calls, ${u.tokensIn}+${u.tokensOut} tokens)\n`);

  if (cmd === "scan") {
    console.log("  Read-only scan. Re-run with `apply` to reclaim (links + caches).\n");
    return;
  }

  // apply
  if (!hasFlag("yes")) {
    console.log("  Refusing to modify files without --yes. (Links are reversible via `undo`.)\n");
    return;
  }
  const safeLinks = plan.links.filter((l) => l.safe);
  const res = applyLinks(safeLinks, { dryRun: false });
  const journalPath = resolve(flagValue("journal") ?? "./dep-reconcile-journal.json");
  writeJournal(journalPath, res.journal);
  console.log(`  Linked ${res.filesLinked} files, reclaimed ${fmtBytes(res.bytesReclaimed)}.`);
  console.log(`  Undo journal: ${journalPath}  (run: dep-reconcile undo ${journalPath})\n`);
  console.log(`  Caches & unused-dep removals are printed above — run those commands yourself so you stay in control.\n`);
}

function fail(msg: string) {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
