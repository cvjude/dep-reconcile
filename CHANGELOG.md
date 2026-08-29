# Improvement Changelog

The story of how `dep-reconcile` got from a naive baseline to 100% precision, told
against the same 12-case evaluation throughout (`pnpm eval:all`). "Overall F1" and
"projects broken" are the two headline numbers; the second matters as much as the
first, because this tool proposes destructive actions.

| Stage | What I tried and why | Evidence | Decision / Learning |
|---|---|---|---|
| **Baseline** | The naive tool: trust static import-diffing for "unused" and hardlink every byte-identical package (depcheck + pkglink behaviour). | F1 **74%**, precision 58%, recall 100%, **2 projects broken**. | Established the starting point. High recall, but over-flags decoys and links two unsafe packages (`esbuildish` postinstall, `nativemod` native) → would break their consumers. |
| **Iteration 1 — single LLM prompt** | Replace the naive logic with one direct prompt: hand the model package.json + sources + lockfile and ask for the whole answer. Tests whether "just use an LLM" is enough. | F1 **~78–82%** (stochastic across runs), precision 64–70%, **0–2 broken**. | Kept as the fair LLM baseline. The model is better on the dependency decoys than naive, but it is **unreliable**: it still reports some decoys as unused, and on some runs it links unsafe packages and breaks builds. Reasoning alone is neither precise nor *stable* enough for destructive actions. |
| **Iteration 2 — evidence collectors** | Add deterministic tools the agent can lean on: a config/script/`@types` **usage scanner** and a **safety prober** (install hooks, native binaries, patches, content hashes). Give the agent facts instead of raw files. | Candidate evidence now carries "used in npm script", "referenced in eslint config", "type-only in a TS project". | Kept. Facts should be computed, not guessed. This is the "better tools" lever — it sets up the verifier to succeed, but on its own doesn't change the decision. |
| **Iteration 3 — adversarial verification** | For every "unused"/"phantom" candidate, run a verifier prompted to **refute** removal ("find any evidence this is used"), defaulting to *keep*. Run verifications in parallel. | F1 **100%**, precision **100%**, recall 100%, **0 broken**. Stable across 3 repeated runs. ~8 calls / ~6K tokens. | Kept — this is the main contribution. The refute-first framing eliminates the decoy false positives that plain reasoning missed. |
| **Removed experiment — LLM decides link safety** | Briefly had the agent judge link-safety from install-hook/native/patch facts. | The facts are unambiguous and checkable; routing them through the model only added latency and a chance of error. | Removed. **Learning:** don't spend the model on questions a deterministic check answers perfectly. Concentrate LLM judgement where the ambiguity actually is (is a config reference "use"?), and let tools own the facts. |
| **Final** | Evidence collectors + adversarial verification + a deterministic safety gate on links + the cache lever, assembled into one risk-ranked, reversible plan. | F1 **100%**, 0 broken; naive → final is **+26 F1 points and −2 broken projects**. | The main contribution is the verifier; the safety prober is what makes the disk win *safe*. |

## What the progression proves

The decisive gains came between "a single smart prompt" and "the same model plus a
dedicated verification pass": **precision rose to 100% and the result became stable.**
That isolates the cause — it was **verification and deterministic safety facts, not model
capability**, that closed the gap. The single prompt was not just less precise; it was
*unreliable*, occasionally linking unsafe packages and breaking builds. The naive baseline's
larger raw disk number likewise came bundled with two broken services — which is why the
evaluation scores **damage (projects broken)** next to **work (MB reclaimed)**.
