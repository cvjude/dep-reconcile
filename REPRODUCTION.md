# Reproduction guide

Everything below runs from a clean checkout. The evaluation uses a **generated**
synthetic workspace (no committed `node_modules`), so results are deterministic and
identical on any machine. Commands use `npm` (ships with Node); `pnpm`/`yarn` work too.

## Requirements

- **Node.js ≥ 20** (developed on 22.x)
- An **Anthropic API key** for the LLM baseline and the agent (`ANTHROPIC_API_KEY`).
  The deterministic parts run without it.

Approximate cost/runtime for the full eval: **~8–9 Claude calls, ~6K tokens total, well under a cent**, ~20–40s wall-clock.

## Setup

```bash
git clone <repo> dep-reconcile && cd dep-reconcile
npm install
export ANTHROPIC_API_KEY=sk-ant-...     # required for `prompt` and `agent`
```

Optional: pick the model (default `claude-sonnet-5`):

```bash
export DR_MODEL=claude-sonnet-5
```

## Step 1 — generate the fixture workspace

```bash
npm run gen-fixtures
```

Creates `eval/fixtures/workspace/` with three projects (`appA`, `appB`, `appC`) and
`expected.json` (the answer key: **13 labeled cases**). Deterministic — same bytes every run.

## Step 2 — run the evaluation

Run all three tools on the same cases and print the scoreboard:

```bash
npm run eval:all
```

Representative output:

```
  TOOL     unused-F1  phantom-F1  drift-F1  link-F1  overall-F1  broken  reclaim
  naive         67%       100%     100%     67%        74%       2    1.5 KB
  prompt        75%       100%     100%     67%        78%       2    1.4 KB
  agent        100%       100%     100%    100%       100%       0     773 B
```

Notes on stability:

- **naive** is deterministic — identical every run (74% F1, breaks 2 projects).
- **prompt** (single LLM call) is **stochastic** — expect ~78–82% F1 and **0–2 broken
  projects** across runs. It is not reliable enough to trust with destructive actions.
- **agent** is **stable at 100% F1 / 0 broken** across repeated runs.

Run a single tool:

```bash
npm run eval:baseline   # naive
npm run eval:prompt     # single LLM prompt
npm run eval:agent      # the agent
```

Per-tool raw output and scores are written to `out/eval-<tool>.json`.

## Step 3 — see the product (the CLI)

Read-only plan on the fixtures (agent mode):

```bash
npx tsx src/cli.ts scan eval/fixtures/workspace/appA eval/fixtures/workspace/appB eval/fixtures/workspace/appC --no-caches
```

Deterministic mode (no API key needed — high-recall, unverified):

```bash
npx tsx src/cli.ts scan eval/fixtures/workspace/appA eval/fixtures/workspace/appB eval/fixtures/workspace/appC --deterministic --no-caches
```

## Step 4 — apply and undo (safe, reversible)

```bash
# regenerate a clean workspace first
npm run gen-fixtures

# link byte-identical safe packages across the three projects
npx tsx src/cli.ts apply eval/fixtures/workspace/appA eval/fixtures/workspace/appB eval/fixtures/workspace/appC \
  --deterministic --no-caches --yes --journal /tmp/dr.json

# verify appA/appB/appC now share one inode for a shared package:
ls -i eval/fixtures/workspace/app*/node_modules/leftpad/index.js

# reverse it — restores independent copies (content is identical, so loss-free):
npx tsx src/cli.ts undo /tmp/dr.json
```

## What each output means

- **F1 / precision / recall** are computed against `expected.json` over unused + phantom + drift + safe-links.
- **broken** = number of *unsafe* packages a tool chose to link (each would break its consumers).
- **reclaim** = disk the tool's chosen actions would free.

## Agent trajectories

Representative agent traces (system prompt, input evidence, response) are written to
`trajectories/*.jsonl` during any agent run — one file per verifier (`agent-verify-unused`,
`agent-verify-phantom`) plus `agent-summary.jsonl` recording what was confirmed vs. refuted
and why.

## Running on real projects

Point `scan` at real project dirs, or a parent directory (it finds child projects):

```bash
npx tsx src/cli.ts scan ~/apps
```

Note: `scan` hashes package contents to find byte-identical copies, which is I/O-heavy
over large `node_modules`. Scope it to the projects you care about rather than an entire
home directory.
