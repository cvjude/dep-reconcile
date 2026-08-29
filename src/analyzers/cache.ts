import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { CacheLever } from "../types.js";
import { dirSize } from "../util.js";

/**
 * Detect reclaimable package-manager caches. These are the "free MB" lever:
 * clearing them only forces a re-download, never breaks a build.
 *
 * NOTE: the pnpm *store* is deliberately NOT offered for deletion — it is the
 * backing store that pnpm projects hardlink to, so nuking it breaks them. Only
 * `pnpm store prune` (unreferenced blobs) is safe, so we surface that command.
 */
export function detectCaches(): CacheLever[] {
  const home = homedir();
  const isMac = platform() === "darwin";
  const levers: CacheLever[] = [];

  const npmCache = join(home, ".npm", "_cacache");
  if (existsSync(npmCache)) {
    levers.push({
      tool: "npm",
      path: npmCache,
      bytes: dirSize(npmCache),
      action: "npm cache clean --force",
      risk: "very-low",
      note: "download cache; clearing only re-downloads on next install",
    });
  }

  const yarnCache = isMac ? join(home, "Library", "Caches", "Yarn") : join(home, ".cache", "yarn");
  if (existsSync(yarnCache)) {
    levers.push({
      tool: "yarn",
      path: yarnCache,
      bytes: dirSize(yarnCache),
      action: "yarn cache clean",
      risk: "very-low",
      note: "download cache; safe to clear",
    });
  }

  // pnpm store: prune only (safe), never delete wholesale.
  const pnpmStore = [join(home, ".pnpm-store"), join(home, "Library", "pnpm", "store"), join(home, ".local", "share", "pnpm", "store")].find(
    existsSync,
  );
  if (pnpmStore) {
    levers.push({
      tool: "pnpm",
      path: pnpmStore,
      bytes: dirSize(pnpmStore),
      action: "pnpm store prune",
      risk: "low",
      note: "removes only UNREFERENCED blobs; the store itself must stay (projects hardlink to it)",
    });
  }

  return levers;
}
