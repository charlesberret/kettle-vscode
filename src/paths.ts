import * as fs from "node:fs";
import * as path from "node:path";
import type { QueueEntry } from "./api";
import { entryAbsolutePath, entryDisplayPath, tryRealpath } from "./project";

/** Resolve entry.path against project root (realpath-aware). */
export function entryAbsPath(entry: QueueEntry, projectRoot: string): string {
  return entryAbsolutePath(entry.path, projectRoot);
}

/**
 * Absolute path to the project's desk folder.
 * Prefer `.kettle/`; fall back to legacy `.setsweep/` when that exists
 * (Setsweep → Kettle transition).
 */
export function kettleDeskDir(projectRoot: string): string {
  const root = path.normalize(projectRoot.replace(/\/+$/, ""));
  const kettle = path.join(root, ".kettle");
  const legacy = path.join(root, ".setsweep");
  try {
    if (fs.existsSync(kettle)) return kettle;
  } catch {
    /* prefer kettle path below */
  }
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    /* write path defaults to .kettle */
  }
  return kettle;
}

/**
 * True when `filePath` is the desk folder itself or a file under it.
 * Used to re-reveal Explorer when founding writes land.
 * Matches both `.kettle` and legacy `.setsweep`.
 */
export function isUnderKettleDesk(
  filePath: string,
  projectRoot: string | undefined,
): boolean {
  if (!filePath || !projectRoot) return false;
  const root = path.normalize(projectRoot.replace(/\/+$/, ""));
  const desks = [path.join(root, ".kettle"), path.join(root, ".setsweep")];
  const target = tryRealpath(filePath);
  for (const deskLex of desks) {
    const desk = tryRealpath(deskLex);
    if (desk && target && (target === desk || target.startsWith(desk + path.sep))) {
      return true;
    }
    const d = deskLex.replace(/\\/g, "/");
    const t = path.normalize(filePath).replace(/\\/g, "/");
    if (t === d || t.startsWith(d + "/")) return true;
  }
  return false;
}

/**
 * Match an editor / Explorer fsPath to a queue entry.
 *
 * Core may store absolute paths under an alternate symlinked root. We try
 * realpath equality, project-relative tails, and
 * unique basename as a last resort.
 */
export function findEntryForEditorPath(
  fsPath: string,
  entries: QueueEntry[],
  projectRoot: string | undefined,
): QueueEntry | undefined {
  if (!fsPath || !entries.length) return undefined;

  const norm = tryRealpath(fsPath);
  const normLower = norm.toLowerCase();

  // 1) Realpath absolute match
  for (const e of entries) {
    const abs = projectRoot
      ? tryRealpath(entryAbsolutePath(e.path, projectRoot))
      : path.isAbsolute(e.path)
        ? tryRealpath(e.path)
        : "";
    if (abs && (abs === norm || abs.toLowerCase() === normLower)) return e;
  }

  // 2) Relative tail under project root (lexical + real)
  if (projectRoot) {
    const root = tryRealpath(projectRoot);
    const rootLex = path.normalize(projectRoot.replace(/\/+$/, ""));
    for (const base of [root, rootLex]) {
      if (!base) continue;
      if (norm === base || norm.startsWith(base + path.sep)) {
        const rel = path.relative(base, norm);
        if (!rel || rel.startsWith("..")) continue;
        const hit = entries.find((e) => {
          const ep = path.normalize(e.path).replace(/^\.\//, "");
          if (ep === rel || ep.replace(/\\/g, "/") === rel.replace(/\\/g, "/")) return true;
          // entry stored absolute — compare display-relative
          if (projectRoot) {
            const d = entryDisplayPath(e.path, projectRoot);
            return d === rel || d.replace(/\\/g, "/") === rel.replace(/\\/g, "/");
          }
          return false;
        });
        if (hit) return hit;
      }
    }

    // 3) Suffix match: .../proteus/docs/foo.md vs any spelling of root
    const rootName = path.basename(root);
    const parts = norm.split(path.sep);
    const idx = parts.lastIndexOf(rootName);
    if (idx >= 0 && idx < parts.length - 1) {
      const relFromName = parts.slice(idx + 1).join(path.sep);
      const hit = entries.find((e) => {
        const d = projectRoot ? entryDisplayPath(e.path, projectRoot) : path.basename(e.path);
        return (
          d === relFromName ||
          d.replace(/\\/g, "/") === relFromName.replace(/\\/g, "/") ||
          path.normalize(e.path).endsWith(relFromName)
        );
      });
      if (hit) return hit;
    }
  }

  // 4) Unique basename on the queue
  const base = path.basename(norm);
  const basenames = entries.filter((e) => path.basename(e.path) === base);
  if (basenames.length === 1) return basenames[0];

  return undefined;
}
