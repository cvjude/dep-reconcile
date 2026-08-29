# dep-reconcile

**Safely reclaim disk on a multi-project Node server — remove verified-unused dependencies and link verified-safe shared packages — without breaking a single service.**

An agentic workflow submission for the micro1 Agentic Workflows Hackathon.

---

## Who has this problem?

A solo founder (me) runs **9 Node.js services on one small EC2 box** to keep infra costs down. The disk is a 30 GB volume that is 40% full, and roughly **3.5 GB of that is `node_modules`** — the same packages copied across a dozen projects, plus dead dependencies nobody imports anymore, plus package-manager caches.

The obvious fix — "switch everything to pnpm" — is a non-starter: these are nine *already-deployed* services on npm, and nobody is going to migrate and redeploy all of them to save disk. The other obvious fix — a blind hardlinker like `pkglink` — is **dangerous**: it will happily share a package that one project has `patch-package`'d, or one with a `postinstall` script or a native `.node` binary, and silently break a running service.

## The bottleneck

The disk is bloated by duplication that is *unsafe to remove naively*:

- **Cross-project duplication.** `react`, `express`, `lodash` etc. are copied into every project's `node_modules`. Two of my services are the same app in two environments — their `node_modules` are byte-for-byte the same size.
- **Dead dependencies.** Every project accretes packages that were tried and abandoned but never removed.
- **Caches.** `~/.npm/_cacache` and `~/.cache` quietly accumulate hundreds of MB.

The judgement calls are what make this hard, and what make it a bad fit for a one-line script:

- Is a dependency *really* unused, or is it a CLI tool used in an npm script, an eslint plugin referenced by string, a `@types/*` package used only by the type-checker, or something loaded via a dynamic import?
- Is a duplicated package *safe* to collapse into one shared copy, or does it have an install hook / native binary / local patch that makes each project's copy legitimately different?

Get the first wrong and you delete something the build needs. Get the second wrong and you break a service in production.

## What it does

`dep-reconcile` reconciles the **four truths** of a project's dependencies —

| truth | source |
|---|---|
| **declared** | `package.json` |
| **locked** | `package-lock.json` |
| **installed** | `node_modules` on disk |
| **used** | what the source actually imports (AST) |

— across every project on the machine, and produces a **risk-ranked reclamation plan** with three levers:

1. **Prune caches** — the safe, instant lever (`npm cache clean`, `yarn cache clean`, `pnpm store prune`).
2. **Remove verified-unused deps** — the ambiguous, judgement-heavy lever.
3. **Link verified-safe shared packages** — hardlink byte-identical copies to one shared inode.

Everything destructive is **read-only by default** (`scan`), gated behind `--yes` (`apply`), and the linking step is **fully reversible** (`undo`).

## Why an agent (and where it actually helps)

Judges reward *purposeful* design, so here is an honest map of which component does what:

- **Deterministic tools** (static-analysis collectors + a safety prober) gather the *facts*: every import site, every config/script reference, install-hooks, native binaries, patches, and content hashes. Facts should be computed, not guessed — so these are plain code, not the LLM.
- **The agent (Claude) does the judgement the facts leave ambiguous.** Its core move is **adversarial verification**: for every "unused" candidate the deterministic layer flags, a verifier is prompted to *refute* removal — "find any evidence this is actually used" — and defaults to keeping the dependency. This is what turns a high-recall, false-positive-ridden candidate list into a plan you can trust.
- **Orchestration**: candidates are verified in parallel across all projects.
- **Human-in-the-loop**: no file is modified without `--yes`, and links are reversible.

## Measured improvement

Evaluated on a synthetic 3-project workspace with **13 labeled cases** (seeded true positives + deliberate decoys: a script-only bin, a config-only eslint plugin, a type-only `@types` package, a dynamically-required module, and two packages that are byte-identical but unsafe to link). The workspace is generated deterministically (`npm run gen-fixtures`) so the answer key is exact and the eval is reproducible.

Same task, same cases, three tools:

| Tool | Overall F1 | Precision | Recall | Projects broken |
|---|---|---|---|---|
| **naive** (depcheck + pkglink style) | 74% | 58% | 100% | **2** |
| **prompt** (one direct LLM call) | ~78–82% | 64–70% | 100% | **0–2** (unstable) |
| **agent** (evidence + adversarial verification) | **100%** | **100%** | 100% | **0** |

- The **naive** tool has perfect recall but over-reports (the three decoys) *and* links two unsafe packages — it would take down two services. (Deterministic: same result every run.)
- A **single LLM prompt** does better on the dependency decoys but is **unreliable**: across runs it scores 78–82% and *sometimes links unsafe packages and breaks builds* (0–2 projects). Reasoning alone is neither precise enough nor stable enough to trust with destructive actions.
- The **agent** eliminates the false positives and the breakage — **100% precision at 100% recall, 0 broken** — for **~8 calls / ~6K tokens** (fractions of a cent), and is **stable across repeated runs**.

Two things separate the agent from a single prompt: the **precision** (the verification pass kills the decoy false positives) and the **reliability** (deterministic safety facts gate the links, instead of the model guessing). See [CHANGELOG.md](./CHANGELOG.md) for the iteration-by-iteration story.

## Main failure mode & hot take

**Failure mode observed:** the most *productive-looking* tool is the most dangerous. Naive dedup reclaims the most megabytes and breaks the most builds, because **byte-identity is not the same as safe-to-share** — a `postinstall` hook, a native binary, or a local patch makes an otherwise-identical package unsafe to collapse. And on real frameworks (NestJS was the wake-up call), static "unused" detection is a false-positive machine: `passport`, `pg`, `reflect-metadata` all look unused to a naive importer because they're wired through decorators, dependency injection, and side-effect imports.

**Hot take:** *a cheap verifier that tries to **refute** each finding beat a smarter finder.* The single-prompt model was already a strong reasoner; what closed the gap to 100% precision was a dedicated adversarial pass whose only job is to prove a candidate wrong before we act on it. Next time I build an agent that proposes destructive actions, the verification step is the first thing I'll design, not the last — and I'll measure "damage done" (projects broken) alongside "work done" (MB reclaimed), because optimizing the second alone rewards recklessness.

## Usage

```bash
npm install

# read-only: print the reclamation plan for one or more projects (or a parent dir)
ANTHROPIC_API_KEY=sk-... npx tsx src/cli.ts scan ~/apps/appA ~/apps/appB

# apply the safe, reversible links (caches & unused removals are printed for you to run)
ANTHROPIC_API_KEY=sk-... npx tsx src/cli.ts apply ~/apps --yes --journal ./journal.json

# reverse every link
npx tsx src/cli.ts undo ./journal.json

# deterministic mode (no LLM): high-recall candidates, unverified
npx tsx src/cli.ts scan ~/apps --deterministic
```

See [REPRODUCTION.md](./REPRODUCTION.md) to reproduce the evaluation from a clean environment, and [`trajectories/`](./trajectories) for representative agent traces.

## What existed before vs. what I built

Everything in this repository was written for the hackathon. It uses standard libraries (`@babel/parser` for the AST, the Anthropic SDK for the agent) and no pre-existing project code.

## Scope & future work

- v1 targets **npm** (`package-lock.json`). pnpm/yarn lockfile parsing is a natural extension.
- **Version convergence** ("11 of your 12 lodash copies can safely bump to 4.17.21 and share") is the one genuinely-agentic dedup extension worth adding next.
- A **"declared but not installed"** state (distinct from unused) would sharpen results on partially-installed projects.
