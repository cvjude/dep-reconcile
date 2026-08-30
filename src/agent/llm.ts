import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.env.DR_MODEL ?? "claude-sonnet-5";
const TRAJ_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "trajectories");

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
}

let tokensIn = 0;
let tokensOut = 0;
let calls = 0;

export function usage() {
  return { calls, tokensIn, tokensOut, model: MODEL };
}

/** Append one step to a trajectory file so judges can follow the agent's reasoning. */
export function recordTrajectory(name: string, entry: Record<string, unknown>) {
  try {
    mkdirSync(TRAJ_DIR, { recursive: true });
    appendFileSync(join(TRAJ_DIR, `${name}.jsonl`), JSON.stringify(entry) + "\n");
  } catch {
    // trajectory logging is best-effort
  }
}

function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const startArr = text.indexOf("[");
  const first = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
  if (first >= 0) return text.slice(first).trim();
  return text.trim();
}

/**
 * Ask Claude for a JSON answer. Retries on transient errors and on unparseable
 * output. Records the exchange to a trajectory file when `traj` is given.
 */
export async function askJson<T>(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  traj?: string;
}): Promise<T> {
  const c = getClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await c.messages.create({
        model: MODEL,
        max_tokens: opts.maxTokens ?? 1500,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
      });
      calls++;
      tokensIn += res.usage.input_tokens;
      tokensOut += res.usage.output_tokens;
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text.trim()) throw new Error("empty response from model");
      const parsed = JSON.parse(extractJson(text)) as T;
      if (opts.traj) recordTrajectory(opts.traj, { system: opts.system, user: opts.user, response: text });
      return parsed;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}
