import { copyFileSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { LinkCandidate } from "../types.js";

export interface JournalEntry {
  canonical: string;
  target: string;
  size: number;
}
export interface ApplyResult {
  filesLinked: number;
  bytesReclaimed: number;
  journal: JournalEntry[];
  skipped: string[];
}

/** List every regular file in a package dir, relative to it (skips nested node_modules). */
function relFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * Replace byte-identical package copies with hardlinks to one canonical copy.
 * Only regular files on the SAME filesystem are linked; every change is recorded
 * to a journal so `undo` can restore independent copies (content is identical, so
 * restoring is loss-free). Set dryRun to compute the plan without touching disk.
 */
export function applyLinks(links: LinkCandidate[], opts: { dryRun: boolean }): ApplyResult {
  const result: ApplyResult = { filesLinked: 0, bytesReclaimed: 0, journal: [], skipped: [] };

  for (const link of links) {
    if (!link.safe) {
      result.skipped.push(`${link.key} (${link.safetyReason})`);
      continue;
    }
    const [canonical, ...others] = link.copies;
    if (!canonical) continue;
    let canonDev: number;
    try {
      canonDev = statSync(canonical).dev;
    } catch {
      continue;
    }

    for (const target of others) {
      let targetDev: number;
      try {
        targetDev = statSync(target).dev;
      } catch {
        continue;
      }
      if (targetDev !== canonDev) {
        result.skipped.push(`${link.key} @ ${target} (cross-filesystem)`);
        continue;
      }

      for (const rel of relFiles(canonical)) {
        const cpath = join(canonical, rel);
        const tpath = join(target, rel);
        try {
          const cst = statSync(cpath);
          if (!existsSync(tpath)) continue;
          const tst = statSync(tpath);
          if (cst.ino === tst.ino) continue; // already the same inode
          if (opts.dryRun) {
            result.filesLinked++;
            result.bytesReclaimed += cst.size;
            continue;
          }
          // Atomic-ish swap: link canonical to a temp name in the target dir, then rename over.
          const tmp = `${tpath}.dr-tmp-${process.pid}`;
          linkSync(cpath, tmp);
          renameSync(tmp, tpath);
          result.filesLinked++;
          result.bytesReclaimed += cst.size;
          result.journal.push({ canonical: cpath, target: tpath, size: cst.size });
        } catch {
          result.skipped.push(`${link.key} file ${rel}`);
        }
      }
    }
  }
  return result;
}

/** Write the undo journal so a later `--undo` can reverse the links. */
export function writeJournal(path: string, entries: JournalEntry[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

/** Restore independent copies from a journal (content is identical, so loss-free). */
export function undo(journalPath: string): { restored: number; failed: number } {
  const entries = JSON.parse(readFileSync(journalPath, "utf8")) as JournalEntry[];
  let restored = 0;
  let failed = 0;
  // Reverse order for safety.
  for (const e of entries.reverse()) {
    try {
      const cst = statSync(e.canonical);
      const tst = statSync(e.target);
      if (cst.ino !== tst.ino) continue; // no longer linked — leave as-is
      const tmp = `${e.target}.dr-undo-${process.pid}`;
      copyFileSync(e.canonical, tmp); // independent inode
      renameSync(tmp, e.target);
      restored++;
    } catch {
      failed++;
    }
  }
  return { restored, failed };
}
