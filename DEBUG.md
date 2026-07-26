# Kettle Debug

## Command

**Kettle: Debug** (Command Palette, or click the status-bar Kettle item)

Runs a full snapshot:

- Extension identity / install path / host (Cursor vs VS Code)
- Core connection + ping
- Project, root, founding phase, queue size, last entry
- Selection sync (editor ↔ queue path match + TreeView.reveal)

Aliases (same action): `kettle.showDebugLog`, `kettle.debugSelectionSync`.

## Where logs go

| Sink | Path |
|------|------|
| Output channel | **Output → Kettle Debug** |
| On-disk mirror | **`~/.cache/kettle/plugin-debug.log`** |

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
