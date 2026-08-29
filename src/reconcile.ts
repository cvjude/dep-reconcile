import type { Candidate, LinkCandidate, ProjectEvidence } from "./types.js";

/**
 * Generate deterministic candidates for one project. This layer is deliberately
 * *naive* and high-recall: it flags anything that looks off and attaches the raw
 * evidence. Turning candidates into verified findings (and discarding the many
 * false positives) is the agent's job.
 */
export function generateCandidates(ev: ProjectEvidence): Candidate[] {
  const candidates: Candidate[] = [];
  const declaredNames = new Set(ev.declared.map((d) => d.name));
  const importedNames = new Set(ev.imports.map((i) => i.pkg));

  // --- unused: declared but not imported anywhere ---
  for (const dep of ev.declared) {
    if (importedNames.has(dep.name)) continue;
    if (dep.kind === "peer") continue; // peers are provided by the host, not imported here

    const evidence: string[] = [`declared as ${dep.kind} dependency ("${dep.range}") but no import site found`];
    const signals = ev.usageSignals.filter((s) => s.pkg === dep.name);
    for (const s of signals) evidence.push(`possible use — ${s.where}: ${s.detail}`);
    if (dep.name.startsWith("@types/")) {
      evidence.push(`type-only package; project ${ev.hasTypeScript ? "uses" : "does not use"} TypeScript`);
    }
    const size = ev.installedSizes[`${dep.name}@${ev.installed[dep.name]}`];
    candidates.push({
      kind: "unused",
      pkg: dep.name,
      project: ev.name,
      evidence,
      reclaimBytes: size,
    });
  }

  // --- phantom: imported but not declared ---
  for (const imp of ev.imports) {
    if (declaredNames.has(imp.pkg)) continue;
    if (imp.pkg.startsWith("@types/")) continue; // never imported at runtime
    // Only flag once per package, but keep a couple of concrete sites as evidence.
    if (candidates.some((c) => c.kind === "phantom" && c.pkg === imp.pkg)) continue;
    const sites = ev.imports
      .filter((i) => i.pkg === imp.pkg)
      .slice(0, 3)
      .map((i) => `${i.style} at ${i.file}:${i.line}`);
    candidates.push({
      kind: "phantom",
      pkg: imp.pkg,
      project: ev.name,
      evidence: [`imported but not in package.json`, ...sites],
    });
  }

  // --- version-drift: declared / locked / installed disagree ---
  for (const dep of ev.declared) {
    const locked = ev.locked[dep.name];
    const installed = ev.installed[dep.name];
    if (locked && installed && locked !== installed) {
      candidates.push({
        kind: "version-drift",
        pkg: dep.name,
        project: ev.name,
        evidence: [`lockfile pins ${locked} but node_modules has ${installed} (declared ${dep.range})`],
        drift: { declared: dep.range, locked, installed },
      });
    }
  }

  return candidates;
}

/**
 * Find cross-project opportunities to share one physical copy of a package.
 * Groups installed packages by *content hash* (true byte identity), then marks
 * each group safe/unsafe based on the deterministic safety facts.
 */
export function generateLinkCandidates(evidences: ProjectEvidence[]): LinkCandidate[] {
  // Global size lookup: name@version -> bytes.
  const sizeOf: Record<string, number> = {};
  for (const ev of evidences) Object.assign(sizeOf, ev.installedSizes);

  // Group every installed package copy by content hash.
  const groups = new Map<
    string,
    { key: string; copies: { path: string; project: string; unsafe: string[] }[] }
  >();

  for (const ev of evidences) {
    for (const s of ev.safety) {
      const unsafe: string[] = [];
      if (s.hasInstallScript) unsafe.push("install script");
      if (s.hasNativeBinary) unsafe.push("native binary");
      if (s.isPatched) unsafe.push("patched");
      const g = groups.get(s.contentHash) ?? { key: `${s.name}@${s.version}`, copies: [] };
      g.copies.push({ path: s.path, project: ev.name, unsafe });
      groups.set(s.contentHash, g);
    }
  }

  const out: LinkCandidate[] = [];
  for (const [hash, g] of groups) {
    // Need identical copies in at least two *different* projects.
    const projects = new Set(g.copies.map((c) => c.project));
    if (g.copies.length < 2 || projects.size < 2) continue;

    const perCopyBytes = sizeOf[g.key] ?? 0;
    const reclaimBytes = (g.copies.length - 1) * perCopyBytes;
    const unsafeReasons = [...new Set(g.copies.flatMap((c) => c.unsafe))];
    const safe = unsafeReasons.length === 0;

    out.push({
      key: g.key,
      contentHash: hash,
      copies: g.copies.map((c) => c.path),
      perCopyBytes,
      reclaimBytes,
      safe,
      safetyReason: safe
        ? "byte-identical, no install script / native / patch — safe to hardlink"
        : `unsafe to link: ${unsafeReasons.join(", ")}`,
    });
  }

  // Biggest reclaim first.
  out.sort((a, b) => b.reclaimBytes - a.reclaimBytes);
  return out;
}
