import type { Candidate, LinkCandidate, ProjectEvidence, ToolOutput, VerifiedDiscrepancy } from "../types.js";
import { generateCandidates, generateLinkCandidates } from "../reconcile.js";
import { askJson, recordTrajectory } from "./llm.js";

export interface AgentResult {
  unused: VerifiedDiscrepancy[]; // confirmed only
  phantom: VerifiedDiscrepancy[]; // confirmed only
  drift: Candidate[];
  links: LinkCandidate[]; // all groups, each carrying its safe flag
}

const UNUSED_SYSTEM = [
  "You verify whether a Node.js dependency is TRULY UNUSED (safe to remove) or actually used.",
  "You are given deterministic evidence gathered by static analysis.",
  "Be conservative and adversarial: your job is to REFUTE removal if there is ANY plausible evidence of use.",
  "A dependency is USED (verdict 'refuted') if it is: invoked as a CLI binary in an npm script; referenced by name in a config file (eslint/babel/jest/etc.); a type-only @types/* package in a project that uses TypeScript; or loaded via a dynamic import/require.",
  "Only answer verdict 'confirmed' (safe to remove) when there is NO evidence of use of any kind.",
  'Respond with ONLY JSON: {"verdict":"confirmed"|"refuted","reason":"<one sentence>"}',
].join("\n");

const PHANTOM_SYSTEM = [
  "You verify whether a package is a GENUINE phantom dependency: used by the code but not declared in package.json, which will break under strict installs (pnpm/CI).",
  "REFUTE (verdict 'refuted') if the package is actually a Node built-in, is in fact declared, is only a subpath of a declared package, or is a type-only artifact never present at runtime.",
  "Otherwise confirm it.",
  'Respond with ONLY JSON: {"verdict":"confirmed"|"refuted","reason":"<one sentence>"}',
].join("\n");

async function verifyUnused(c: Candidate, ev: ProjectEvidence): Promise<VerifiedDiscrepancy> {
  const user = JSON.stringify(
    {
      package: c.pkg,
      project: c.project,
      projectUsesTypeScript: ev.hasTypeScript,
      evidence: c.evidence,
    },
    null,
    2,
  );
  const { verdict, reason } = await askJson<{ verdict: "confirmed" | "refuted"; reason: string }>({
    system: UNUSED_SYSTEM,
    user,
    maxTokens: 300,
    traj: "agent-verify-unused",
  });
  return { ...c, verdict, reason, fix: verdict === "confirmed" ? `npm uninstall ${c.pkg}` : undefined };
}

async function verifyPhantom(c: Candidate, declaredNames: string[]): Promise<VerifiedDiscrepancy> {
  const user = JSON.stringify({ package: c.pkg, evidence: c.evidence, declaredInProject: declaredNames }, null, 2);
  const { verdict, reason } = await askJson<{ verdict: "confirmed" | "refuted"; reason: string }>({
    system: PHANTOM_SYSTEM,
    user,
    maxTokens: 300,
    traj: "agent-verify-phantom",
  });
  return { ...c, verdict, reason, fix: verdict === "confirmed" ? `npm install ${c.pkg}` : undefined };
}

/** Full agentic analysis: deterministic evidence -> adversarial verification -> safe decisions. */
export async function analyzeWithAgent(evidences: ProjectEvidence[]): Promise<AgentResult> {
  const allUnused: Candidate[] = [];
  const allPhantom: Candidate[] = [];
  const drift: Candidate[] = [];

  for (const ev of evidences) {
    for (const c of generateCandidates(ev)) {
      if (c.kind === "unused") allUnused.push(c);
      else if (c.kind === "phantom") allPhantom.push(c);
      else drift.push(c);
    }
  }

  const evByName = new Map(evidences.map((e) => [e.name, e]));

  // Verify every candidate in parallel (orchestration across candidates).
  const [verifiedUnused, verifiedPhantom] = await Promise.all([
    Promise.all(allUnused.map((c) => verifyUnused(c, evByName.get(c.project)!))),
    Promise.all(
      allPhantom.map((c) =>
        verifyPhantom(
          c,
          (evByName.get(c.project)?.declared ?? []).map((d) => d.name),
        ),
      ),
    ),
  ]);

  recordTrajectory("agent-summary", {
    candidates: { unused: allUnused.length, phantom: allPhantom.length, drift: drift.length },
    confirmed: {
      unused: verifiedUnused.filter((v) => v.verdict === "confirmed").length,
      phantom: verifiedPhantom.filter((v) => v.verdict === "confirmed").length,
    },
    refuted: verifiedUnused.filter((v) => v.verdict === "refuted").map((v) => `${v.project}/${v.pkg}: ${v.reason}`),
  });

  // Links: the safety prober (a tool the agent relies on) decides safety.
  const links = generateLinkCandidates(evidences);

  return {
    unused: verifiedUnused.filter((v) => v.verdict === "confirmed"),
    phantom: verifiedPhantom.filter((v) => v.verdict === "confirmed"),
    drift,
    links,
  };
}

/** Map the rich agent result to the uniform ToolOutput used by the eval. */
export async function runAgent(evidences: ProjectEvidence[]): Promise<ToolOutput> {
  const r = await analyzeWithAgent(evidences);
  return {
    unused: r.unused.map((v) => ({ project: v.project, pkg: v.pkg })),
    phantom: r.phantom.map((v) => ({ project: v.project, pkg: v.pkg })),
    drift: r.drift.map((v) => ({ project: v.project, pkg: v.pkg })),
    linkedGroups: r.links.filter((l) => l.safe).map((l) => l.key),
  };
}
