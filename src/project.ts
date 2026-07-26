/**
 * Pure project-resolution helpers (no vscode imports).
 * Used by the extension shell and unit tests.
 *
 * Note: entry paths from core may use a different lexical root than the
 * registry when symlinked working roots point to the same directory. Display
 * paths resolve via realpath when possible.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Project, QueueEntry } from "./api";

function normPath(p: string): string {
  return path.normalize(p.replace(/\/+$/, "") || p);
}

/** realpath when the path exists; otherwise normalized lexical path. */
export function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return normPath(p);
  }
}

/** Expand leading `~/` so registry roots match workspace URIs. */
export function expandUserPath(p: string): string {
  const s = (p || "").trim();
  if (s === "~") return process.env.HOME || process.env.USERPROFILE || s;
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, s.slice(2));
  }
  return s;
}

/**
 * Prefer configured id; else unique workspace↔root match; else undefined (caller picks).
 *
 * Matching rules (when unconfigured):
 * - Workspace folder is the project root, or a descendant of it (realpath).
 * - Symlinked spellings of the same directory match.
 * - Never pick a project merely because it is the only one registered — that
 *   silently loads the wrong desk when the open folder is unregistered (e.g.
 *   another folder open with only an unrelated project registered).
 * - Never match because the project root sits *under* a broader workspace
 *   folder (opening a shared parent must not auto-bind one child project).
 * - Sole registered project is only assumed when there are no workspace folders.
 */
export function resolveProjectId(
  projects: Project[],
  configuredId: string,
  workspaceFolderPaths: string[],
): string | undefined {
  const configured = configuredId.trim();
  if (configured) {
    return projects.some((p) => p.id === configured) ? configured : undefined;
  }

  const folders = workspaceFolderPaths.map(normPath).filter(Boolean);
  if (!folders.length) {
    // Empty window / no folder: sole registered project is a reasonable default.
    if (projects.length === 1) return projects[0].id;
    return undefined;
  }

  const hits = projects.filter((p) => workspaceMatchesProject(folders, p.root));
  if (hits.length === 1) return hits[0].id;

  // Fallback: exact realpath equality (covers odd spellings findProjectByRoot knows).
  if (folders.length === 1) {
    const byRoot = findProjectByRoot(projects, folders[0]);
    if (byRoot) return byRoot.id;
  }
  return undefined;
}

/**
 * True when any workspace folder is this project's root or lives under it.
 * Uses realpath so symlink aliases and expanded home paths for the same Desk
 * match.
 */
export function workspaceMatchesProject(
  workspaceFolderPaths: string[],
  projectRoot: string,
): boolean {
  const root = tryRealpath(expandUserPath(projectRoot));
  if (!root) return false;
  return workspaceFolderPaths.some((f) => {
    const folder = tryRealpath(expandUserPath(f));
    return folder === root || folder.startsWith(root + path.sep);
  });
}

/**
 * Suggest a display name from a folder path (basename, title-cased).
 * Mirrors kettle-core web `nameFromRootPath`.
 */
export function nameFromRootPath(root: string): string {
  const trimmed = (root || "").trim();
  if (!trimmed) return "";
  const base = path.basename(normPath(trimmed));
  if (!base || base === "." || base === path.sep) return "";
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Find a registered project whose root is the same directory as `folder`
 * (lexical or realpath). Used before POST /api/projects/add so re-picking
 * an already-registered desk binds instead of erroring on duplicate id.
 */
export function findProjectByRoot(
  projects: Project[],
  folder: string,
): Project | undefined {
  const target = tryRealpath(expandUserPath(folder));
  const targetNorm = normPath(expandUserPath(folder));
  for (const p of projects) {
    if (!p.root) continue;
    if (tryRealpath(expandUserPath(p.root)) === target) return p;
    if (normPath(expandUserPath(p.root)) === targetNorm) return p;
  }
  return undefined;
}

/**
 * Relative path for queue labels. Prefer project-root-relative; fall back to
 * realpath match when registry root and entry path are different symlinked
 * spellings of the same directory.
 */
export function entryDisplayPath(entryPath: string, projectRoot: string): string {
  const root = projectRoot.replace(/\/+$/, "");
  if (!root) return entryPath;

  const strip = (base: string, full: string): string | undefined => {
    const b = normPath(base);
    const f = normPath(full);
    if (f === b) return path.basename(f);
    if (f.startsWith(b + path.sep)) return f.slice(b.length + 1);
    return undefined;
  };

  const lexical = strip(root, entryPath);
  if (lexical !== undefined) return lexical;

  // Realpath pass for symlinked working roots.
  const realRoot = tryRealpath(root);
  let absEntry = path.isAbsolute(entryPath)
    ? entryPath
    : path.join(realRoot, entryPath);
  absEntry = tryRealpath(absEntry);
  const viaReal = strip(realRoot, absEntry);
  if (viaReal !== undefined) return viaReal;

  // Last resort: path.relative (may be absolute or ../ if unrelated)
  const rel = path.relative(realRoot, absEntry);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;

  return path.basename(entryPath) || entryPath;
}

/** Absolute fs path for an entry (realpath of project root when possible). */
export function entryAbsolutePath(entryPath: string, projectRoot: string): string {
  if (path.isAbsolute(entryPath)) return tryRealpath(entryPath);
  const root = tryRealpath(projectRoot || ".");
  return tryRealpath(path.join(root, entryPath));
}

/** True when the entry is approved (bookmark), any status spelling. */
export function isApprovedEntry(entry: QueueEntry): boolean {
  const st = (entry.status || "pending").toLowerCase();
  if (st === "approved") return true;
  // Core may set approved to an ISO timestamp string when bookmarked.
  if (entry.approved != null && String(entry.approved).trim() !== "") return true;
  return false;
}

/**
 * Sitting order for the Explorer queue: pending first (stable), approved last.
 * Does not mutate the input array.
 */
export function sortQueueForDisplay(entries: QueueEntry[]): QueueEntry[] {
  const pending: QueueEntry[] = [];
  const approved: QueueEntry[] = [];
  for (const e of entries) {
    if (isApprovedEntry(e)) approved.push(e);
    else pending.push(e);
  }
  return pending.concat(approved);
}

/**
 * Next unapproved entry for openNextOnApprove.
 * - Prefer the entry after `afterId` among still-pending rows.
 * - If `afterId` is no longer pending (typical after refresh), return the
 *   first pending row in display order.
 */
export function nextPendingEntry(
  entries: QueueEntry[],
  afterId?: string | number,
): QueueEntry | undefined {
  const ordered = sortQueueForDisplay(entries);
  const pending = ordered.filter((e) => !isApprovedEntry(e));
  if (!pending.length) return undefined;
  if (afterId == null) return pending[0];
  const idx = pending.findIndex((e) => String(e.id) === String(afterId));
  if (idx < 0) return pending[0];
  return pending[idx + 1] ?? pending[0];
}

/** True when the open editor file is this queue entry. */
export function queueEntryMatchesEditorPath(
  entry: QueueEntry,
  editorPath: string,
  projectRoot: string,
): boolean {
  const active = path.normalize(editorPath);
  const entryAbs = path.isAbsolute(entry.path)
    ? path.normalize(entry.path)
    : path.normalize(path.join(projectRoot, entry.path));
  return active === entryAbs;
}
