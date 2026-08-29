import { readFileSync } from "node:fs";
import type { ProjectEvidence, ToolOutput } from "../types.js";
import { askJson } from "../agent/llm.js";
import { listSourceFiles } from "../util.js";

/**
 * Baseline B1 — a single direct prompt with basic instructions (the baseline the
 * hackathon brief suggests). The model sees package.json, the source files, the
 * lockfile and installed versions in one shot, and must produce the whole answer
 * with no tools, no static analysis, and no verification pass.
 */
export async function runPrompt(evidences: ProjectEvidence[]): Promise<ToolOutput> {
  const projects = evidences.map((ev) => {
    const declared: Record<string, string> = {};
    for (const d of ev.declared) declared[d.name] = d.range;
    const sources = listSourceFiles(ev.projectDir).map((f) => ({
      file: f.slice(ev.projectDir.length + 1),
      content: readFileSync(f, "utf8"),
    }));
    return {
      name: ev.name,
      dependencies: declared,
      installed: ev.installed,
      lockfile: ev.locked,
      sources,
    };
  });

  const system = [
    "You are a Node.js dependency auditor. Analyze the given projects and report dependency problems.",
    "Definitions:",
    "- unused: a dependency declared in package.json that is never actually needed by the project.",
    "- phantom: a package used by the code but NOT declared in package.json.",
    "- drift: a dependency whose lockfile version and installed version disagree.",
    "- linkedGroups: packages installed identically across MULTIPLE projects that could be de-duplicated by hardlinking to one shared copy to save disk. List them as \"name@version\". Only include groups that are SAFE to share.",
    "Respond with ONLY JSON of shape:",
    '{"unused":[{"project","pkg"}],"phantom":[{"project","pkg"}],"drift":[{"project","pkg"}],"linkedGroups":["name@version"]}',
  ].join("\n");

  const user = `Projects:\n${JSON.stringify(projects, null, 2)}`;

  return askJson<ToolOutput>({ system, user, maxTokens: 2000, traj: "baseline-prompt" });
}
