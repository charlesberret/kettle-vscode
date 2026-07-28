# Kettle Debug

## Live Debug panel

**Kettle: Show Debug Panel** (Command Palette, or click the status-bar Kettle
item) opens a live-updating view in the Kettle Desk container (collapsed by
default, next to Desk). It mirrors every `debug.log()` call in the extension
as it happens — desk events, connection errors, approve/sweep/comment
failures — with error-looking lines (`FAIL`, `failed`, `error`, `exception`)
highlighted. Toolbar:

- **Copy Report** — copies extension identity + recent log lines as a
  Markdown-fenced block, ready to paste straight into a coding agent's chat.
  Same content as the **Kettle: Copy Debug Report** command.
- **Clear** — wipes the panel's in-memory view (Output channel and on-disk
  log are untouched).
- **Open Log File** — opens `~/.cache/kettle/plugin-debug.log` in an editor tab.

The status-bar Kettle item shows a `⚠N` badge when errors have been logged
since the last Clear; hovering it shows the count.

## Command: Kettle: Debug

**Kettle: Debug** (Command Palette) runs a full one-shot snapshot into the
Output channel and on-disk log:

- Extension identity / install path / host (Cursor vs VS Code)
- Core connection + ping
- Project, root, founding phase, queue size, last entry
- Selection sync (editor ↔ queue path match + TreeView.reveal)

Aliases (same action): `kettle.showDebugLog`, `kettle.debugSelectionSync`.

## Where logs go

| Sink | Path |
|------|------|
| Output channel | **Output → Kettle Debug** |
| On-disk mirror | **`~/.cache/kettle/plugin-debug.log`** (opt out via `kettle.logToFile`) |
| Live panel | **Kettle Desk → Debug** (in-memory only, last 500 lines) |

Agents and shells can read the file directly:

```sh
tail -n 80 ~/.cache/kettle/plugin-debug.log
```

## Important: which install are you running?

Cursor/VS Code often load the **installed** extension under
`~/.cursor/extensions/charlesberret.kettle-*`, not the git working tree.
Check `extension.path` and `buildId` in the debug output.

## Selection sync details

See [`DEBUG-SELECTION.md`](./DEBUG-SELECTION.md).

## After reload

1. **Developer: Reload Window**
2. Status bar: `Kettle <version> · <buildId>`
3. **Kettle: Debug** if anything looks wrong
