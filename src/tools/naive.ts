import type { ProjectEvidence, ToolOutput } from "../types.js";
import { generateCandidates, generateLinkCandidates } from "../reconcile.js";

/**
 * Baseline B2 — the "naive tool" (in the spirit of depcheck + pkglink).
 * It trusts the deterministic candidates verbatim (no verification) and links
 * every byte-identical package it finds, ignoring safety. This is the tool that
 * over-reports unused deps and happily links packages that will break a build.
 */
export function runNaive(evidences: ProjectEvidence[]): ToolOutput {
  const out: ToolOutput = { unused: [], phantom: [], drift: [], linkedGroups: [] };

  for (const ev of evidences) {
    for (const c of generateCandidates(ev)) {
      const row = { project: c.project, pkg: c.pkg };
      if (c.kind === "unused") out.unused.push(row);
      else if (c.kind === "phantom") out.phantom.push(row);
      else out.drift.push(row);
    }
  }

  // Naive dedup: link anything byte-identical across projects, safety be damned.
  for (const link of generateLinkCandidates(evidences)) {
    out.linkedGroups.push(link.key);
  }

  return out;
}
