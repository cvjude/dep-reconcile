import type { AgentResult } from "./agent/agent.js";
import type { CacheLever, ReclamationPlan } from "./types.js";

/** Assemble the final, risk-ranked reclamation plan from the agent's findings. */
export function buildPlan(agent: AgentResult, caches: CacheLever[]): ReclamationPlan {
  const cacheBytes = caches.reduce((s, c) => s + c.bytes, 0);
  const unusedBytes = agent.unused.reduce((s, u) => s + (u.reclaimBytes ?? 0), 0);
  const safeLinks = agent.links.filter((l) => l.safe);
  const linkBytes = safeLinks.reduce((s, l) => s + l.reclaimBytes, 0);

  return {
    caches,
    unused: agent.unused,
    phantom: agent.phantom,
    drift: agent.drift.map((c) => ({ ...c, verdict: "confirmed" as const, reason: "lockfile and installed version disagree" })),
    links: agent.links,
    totals: {
      cacheBytes,
      unusedBytes,
      linkBytes,
      reclaimableBytes: cacheBytes + unusedBytes + linkBytes,
    },
  };
}
