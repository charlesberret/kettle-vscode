# Debugging selection sync (Explorer ↔ Kettle queue)

## What “selected” means

We want the **same list selection chrome** as a click in the Kettle queue
(highlighted row), when the active editor file is on the queue — **not** a text
badge like `open`.

Host API: `TreeView.reveal(element, { select: true, focus: false })`.

## Pipeline

```
active editor fsPath
    → findEntryForEditorPath (paths.ts)     [pure — unit tested]
    → state.setLastEntry + Desk refresh     [always if match]
    → queueView.diagnoseReveal(entry)       [TreeView.reveal + selection check]
```

Failure can be at **match** or **reveal**. Diagnose both separately.

## Command: Kettle: Debug

1. Open a **queue file** in the editor (from Cursor’s file browser).
2. Expand **Explorer → SETSWEEP** so the tree has loaded rows.
3. Command Palette → **Kettle: Debug** (or click the status-bar Kettle item).
4. Read **Output → Kettle Debug**, or:

```sh
tail -n 100 ~/.cache/kettle/plugin-debug.log
```

### How to read the report

**Path probe**

| Field | Meaning |
|-------|---------|
| `editor` / `editor real` | Active file (lexical + realpath) |
| `root` / `root real` | Bound project root |
| `match id` | Which queue entry matched, or `(none)` |
| `match how` | realpath-absolute / relative-under-root / basename-or-suffix |
| per-row `ABS=editor` | That entry’s realpath equals the editor |
| per-row `REL=editor` | Display path equals path relative to root |

If **`match id` is `(none)`** while the file is on the queue: fix path matching
(symlink roots, registry root vs entry paths). Unit tests live in
`src/test/paths.test.ts`.

**Reveal probe**

| Field | Meaning |
|-------|---------|
| `cacheHit` | Element for this id exists from last `getChildren` |
| `cacheSize` / `cacheIds` | What the provider last handed the TreeView |
| `visible` | Whether the TreeView thinks it is visible |
| `sel before` / `sel after` | `treeView.selection` entry ids |
| `revealOk` | `reveal()` returned without throwing |
| notes | Human explanation |

### Failure modes (what we’ve hit)

1. **Path miss** — entry stored under `Repos/…`, root is `cloud/git-projects/…`
   (or reverse). Matching uses realpath; if still miss, probe rows show why.
2. **Cache miss** — SETSWEEP section never expanded → `getChildren` never ran →
   `reveal` has no host-known element. Expand SETSWEEP once.
3. **`getParent` missing** (confirmed 2026-07-22 on Cursor) — host throws:
   `Required registered TreeDataProvider to implement 'getParent' method to access 'reveal'`.
   Flat lists must implement `getParent` returning `undefined` for every row.
4. **reveal ok but sel after empty** — host ignored selection (collapsed section,
   or TreeItem `command` interaction). Diagnostic retries with `focus: true` once.
5. **Rebuild wiped identity** — list must not full-refresh on `lastEntry` alone
   (see `listSignature` in `queueView.ts`).

## Automated tests

```sh
cd packages/vscode && npm test
```

- `src/test/paths.test.ts` — matching + symlink alias (when OS allows)
- `src/test/project.test.ts` — display paths, queue sort
- `buildSelectionProbe` pure report shape

There is **no** headless test for Cursor’s selection *chrome*; that is host UI.
The diagnostic command is the integration check on a live install.

## Expected healthy log (sketch)

```
match id    some-entry-id
match how   realpath-absolute
cacheHit    true
sel after   some-entry-id
notes:
  - selection after reveal includes entry id — host accepted selection.
```
