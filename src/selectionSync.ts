/**
 * Selection-sync diagnostics — pure helpers for active-editor → queue matching.
 *
 * The TreeView selection highlight is host UI; path matching is pure and unit-tested.
 * Use `formatSelectionProbe` + the Debug Output channel when Cursor misbehaves.
 */
import * as path from "node:path";
import type { QueueEntry } from "./api";
import { entryAbsolutePath, entryDisplayPath, tryRealpath } from "./project";
import { findEntryForEditorPath } from "./paths";

export type PathProbeRow = {
  id: string;
  path: string;
  display: string;
  absolute: string;
  realpath: string;
  basename: string;
  absEqualsEditor: boolean;
  displayEqualsRel: boolean;
};

export type SelectionProbe = {
  at: string;
  reason: string;
  editorFsPath: string | null;
  editorRealpath: string | null;
  projectId: string | null;
  projectRoot: string | null;
  projectRootRealpath: string | null;
  entryCount: number;
  matchId: string | null;
  matchPath: string | null;
  matchMethod: string | null;
  rows: PathProbeRow[];
  notes: string[];
};

/** Build a structured probe of editor path vs every queue row. */
export function buildSelectionProbe(opts: {
  reason: string;
  editorFsPath: string | undefined | null;
  projectId: string | undefined | null;
  projectRoot: string | undefined | null;
  entries: QueueEntry[];
}): SelectionProbe {
  const editorFsPath = opts.editorFsPath?.trim() || null;
  const projectRoot = opts.projectRoot?.trim() || null;
  const editorReal = editorFsPath ? tryRealpath(editorFsPath) : null;
  const rootReal = projectRoot ? tryRealpath(projectRoot) : null;

  const notes: string[] = [];
  if (!editorFsPath) notes.push("No active file editor (or non-file scheme).");
  if (!opts.projectId) notes.push("No project bound.");
  if (!projectRoot) notes.push("No project root.");
  if (!opts.entries.length) notes.push("Queue is empty — nothing to match.");

  const rows: PathProbeRow[] = opts.entries.map((e) => {
    const absolute = projectRoot
      ? entryAbsolutePath(e.path, projectRoot)
      : path.isAbsolute(e.path)
        ? e.path
        : e.path;
    const real = tryRealpath(absolute);
    const display = projectRoot ? entryDisplayPath(e.path, projectRoot) : e.path;
    const relFromEditor =
      rootReal && editorReal && editorReal.startsWith(rootReal + path.sep)
        ? path.relative(rootReal, editorReal)
        : "";
    return {
      id: String(e.id),
      path: e.path,
      display,
      absolute,
      realpath: real,
      basename: path.basename(e.path),
      absEqualsEditor: !!(editorReal && real === editorReal),
      displayEqualsRel: !!(relFromEditor && display === relFromEditor),
    };
  });

  const hit = editorFsPath
    ? findEntryForEditorPath(editorFsPath, opts.entries, projectRoot || undefined)
    : undefined;

  let matchMethod: string | null = null;
  if (hit && editorReal) {
    const row = rows.find((r) => r.id === String(hit.id));
    if (row?.absEqualsEditor) matchMethod = "realpath-absolute";
    else if (row?.displayEqualsRel) matchMethod = "relative-under-root";
    else if (row && path.basename(editorReal) === row.basename) matchMethod = "basename-or-suffix";
    else matchMethod = "findEntryForEditorPath (other)";
  }

  if (editorFsPath && opts.entries.length && !hit) {
    notes.push(
      "No match — check whether editor realpath shares a root with entry realpaths (symlink roots).",
    );
  }

  return {
    at: new Date().toISOString(),
    reason: opts.reason,
    editorFsPath,
    editorRealpath: editorReal,
    projectId: opts.projectId ?? null,
    projectRoot,
    projectRootRealpath: rootReal,
    entryCount: opts.entries.length,
    matchId: hit ? String(hit.id) : null,
    matchPath: hit?.path ?? null,
    matchMethod,
    rows,
    notes,
  };
}

/** Human-readable multi-line report for the Debug Output channel. */
export function formatSelectionProbe(p: SelectionProbe): string {
  const lines: string[] = [
    "—— selection sync probe ——",
    `at          ${p.at}`,
    `reason      ${p.reason}`,
    `project     ${p.projectId ?? "(none)"}`,
    `root        ${p.projectRoot ?? "(none)"}`,
    `root real   ${p.projectRootRealpath ?? "(none)"}`,
    `editor      ${p.editorFsPath ?? "(none)"}`,
    `editor real ${p.editorRealpath ?? "(none)"}`,
    `queue n     ${p.entryCount}`,
    `match id    ${p.matchId ?? "(none)"}`,
    `match path  ${p.matchPath ?? "(none)"}`,
    `match how   ${p.matchMethod ?? "(none)"}`,
  ];
  if (p.notes.length) {
    lines.push("notes:");
    for (const n of p.notes) lines.push(`  - ${n}`);
  }
  if (p.rows.length) {
    lines.push("queue rows:");
    for (const r of p.rows) {
      const flags = [
        r.absEqualsEditor ? "ABS=editor" : "",
        r.displayEqualsRel ? "REL=editor" : "",
        p.matchId === r.id ? "← MATCH" : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `  [${r.id}] ${r.display}`,
        `         path: ${r.path}`,
        `         abs:  ${r.absolute}`,
        `         real: ${r.realpath}`,
        flags ? `         ${flags}` : "         (no path flags)",
      );
    }
  }
  lines.push("—— end probe ——");
  return lines.join("\n");
}

export type RevealProbe = {
  at: string;
  entryId: string;
  cacheHit: boolean;
  cacheSize: number;
  cacheIds: string[];
  treeViewPresent: boolean;
  visible: boolean | null;
  selectionBefore: string[];
  selectionAfter: string[];
  revealThrew: string | null;
  revealOk: boolean;
  notes: string[];
};

export function formatRevealProbe(r: RevealProbe): string {
  const lines = [
    "—— tree reveal probe ——",
    `at              ${r.at}`,
    `entryId         ${r.entryId}`,
    `cacheHit        ${r.cacheHit}`,
    `cacheSize       ${r.cacheSize}`,
    `cacheIds        ${r.cacheIds.join(", ") || "(empty)"}`,
    `treeViewPresent ${r.treeViewPresent}`,
    `visible         ${r.visible}`,
    `sel before      ${r.selectionBefore.join(", ") || "(none)"}`,
    `sel after       ${r.selectionAfter.join(", ") || "(none)"}`,
    `revealThrew     ${r.revealThrew ?? "(no)"}`,
    `revealOk        ${r.revealOk}`,
  ];
  if (r.notes.length) {
    lines.push("notes:");
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  lines.push("—— end reveal ——");
  return lines.join("\n");
}
