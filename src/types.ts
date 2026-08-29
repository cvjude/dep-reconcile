// The shared vocabulary for dep-reconcile.
//
// The tool reconciles four "truths" about a Node project's dependencies and
// then reconciles packages *across* projects on one machine:
//
//   declared  -> package.json
//   locked    -> package-lock.json
//   installed -> node_modules (what is actually on disk)
//   used      -> what the source code actually imports
//
// The deterministic layer gathers *evidence* into these structures; the agent
// layer turns ambiguous evidence into *verified* discrepancies and a plan.

/** A single dependency as declared in package.json. */
export interface DeclaredDep {
  name: string;
  /** The semver range as written, e.g. "^4.17.21". */
  range: string;
  kind: "prod" | "dev" | "peer" | "optional";
}

/** One import/require site discovered by the AST scanner. */
export interface ImportSite {
  /** The bare package name the source refers to (scope-aware, subpath-stripped). */
  pkg: string;
  file: string;
  line: number;
  /** How the reference was written — matters for the agent's judgement. */
  style: "import" | "require" | "dynamic-import" | "import-type" | "export-from";
}

/** A place a package name appears as a *string* outside of code imports. */
export interface UsageSignal {
  pkg: string;
  /** Where we saw it: an npm script, a bin reference, a config file, etc. */
  where: string;
  /** The raw evidence line, so the agent (and a human) can judge it. */
  detail: string;
}

/** Safety facts about an installed package that decide whether it can be shared. */
export interface SafetyFacts {
  name: string;
  version: string;
  /** Absolute path to the installed package inside a project's node_modules. */
  path: string;
  hasInstallScript: boolean;
  hasNativeBinary: boolean;
  isPatched: boolean;
  /** Integrity hash of the package contents (for cross-project identity). */
  contentHash: string;
  /** Human-readable reasons the deterministic prober flagged risk. */
  riskNotes: string[];
}

/** The full deterministic evidence bundle for one project. */
export interface ProjectEvidence {
  projectDir: string;
  name: string;
  declared: DeclaredDep[];
  /** name -> version resolved by the lockfile (top level). */
  locked: Record<string, string>;
  /** name -> version actually present in node_modules. */
  installed: Record<string, string>;
  imports: ImportSite[];
  usageSignals: UsageSignal[];
  safety: SafetyFacts[];
  /** Sizes in bytes, keyed by "name@version", for reclamation math. */
  installedSizes: Record<string, number>;
  /** Whether the project contains TypeScript source (affects @types/* judgement). */
  hasTypeScript: boolean;
}

export type DiscrepancyKind =
  | "unused" // declared but never used anywhere -> removable
  | "phantom" // imported but not declared -> breaks under strict installs
  | "version-drift"; // declared / locked / installed disagree

/** A candidate finding before the agent has verified it. */
export interface Candidate {
  kind: DiscrepancyKind;
  pkg: string;
  project: string;
  /** Deterministic evidence gathered for this candidate. */
  evidence: string[];
  /** Extra structured hints for version drift. */
  drift?: { declared?: string; locked?: string; installed?: string };
  /** Estimated bytes reclaimable if this candidate is acted on. */
  reclaimBytes?: number;
}

export type Verdict = "confirmed" | "refuted" | "uncertain";

/** A candidate after the agent's adversarial verification pass. */
export interface VerifiedDiscrepancy extends Candidate {
  verdict: Verdict;
  /** The agent's one-line justification, tied to evidence. */
  reason: string;
  /** For unused/phantom: the concrete fix. */
  fix?: string;
}

/** A cross-project opportunity to share one physical copy of a package. */
export interface LinkCandidate {
  key: string; // "name@version"
  contentHash: string;
  /** All project paths that hold a byte-identical copy. */
  copies: string[];
  perCopyBytes: number;
  /** bytes reclaimable = (copies - 1) * perCopyBytes */
  reclaimBytes: number;
  safe: boolean;
  /** Why it is / isn't safe to link. */
  safetyReason: string;
}

/** A reclaimable cache on the machine (npm/yarn/pnpm). */
export interface CacheLever {
  tool: "npm" | "yarn" | "pnpm";
  path: string;
  bytes: number;
  action: string; // the safe command, e.g. "npm cache clean --force"
  risk: "very-low" | "low";
  note: string;
}

/** Uniform output shape every tool (baseline + agent) emits, for scoring. */
export interface ToolOutput {
  unused: { project: string; pkg: string }[];
  phantom: { project: string; pkg: string }[];
  drift: { project: string; pkg: string }[];
  /** "name@version" groups the tool decides to hardlink across projects. */
  linkedGroups: string[];
}

/** The final, risk-ranked reclamation plan the agent produces. */
export interface ReclamationPlan {
  caches: CacheLever[];
  unused: VerifiedDiscrepancy[];
  phantom: VerifiedDiscrepancy[];
  drift: VerifiedDiscrepancy[];
  links: LinkCandidate[];
  totals: {
    cacheBytes: number;
    unusedBytes: number;
    linkBytes: number;
    reclaimableBytes: number;
  };
}
