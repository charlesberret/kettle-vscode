# Kettle for VS Code and Cursor

[Kettle](https://github.com/charlesberret/kettle) is a local-first way to
review work produced with coding and writing agents. This extension puts
Kettle's queue of files and its panel inside VS Code and Cursor.

## How it works

Kettle lines up a batch of files from your project for you to review. Open one
from the **Kettle** list in Explorer (or the Kettle panel) to read it with the
agent's summary, edit it, and decide:

- **Approve** — mark your decision on this file. Nothing changes until you
  finish the batch.
- **Comment** — leave a note on this file for the agent to act on.
- **Not this** — set the file aside. The agent takes it as a sign of what you
  don't want and tells you what it learned. **Bring back** puts it back.
- **Finish batch** — the agent applies your decisions, reviews what changed,
  saves a record of this round, and lines up the next files.

A new project starts with a short conversation with the agent, which then
writes a proposal for you to edit and approve; approving it sets the project
up and lines up the first batch.

The extension is an adapter. It talks to
[`kettle-core`](https://github.com/charlesberret/kettle-core), which owns the
project registry, the project files under `.kettle/`, the HTTP contract, the
CLI, and the reference web UI. The words on screen come from core's catalog,
so every Kettle window says the same thing.

## Status

**Pre-release (`0.1.1`).** The extension is usable from source and can be
packaged as a VSIX. It is not yet published to the Visual Studio Marketplace.

During the rename from Setsweep, Kettle prefers the new `kettle` command,
`.kettle/` folder, and Kettle registry. Existing `setsweep` processes,
`.setsweep/` folders, and legacy installs remain readable so a working setup is
not split or stranded.

## Prerequisites

- VS Code 1.95+ or a compatible Cursor release
- Node.js 20+
- a local Kettle core installation; see the
  [core install](https://github.com/charlesberret/kettle-core/blob/main/INSTALL.md)

## Build and install

```sh
npm ci
npm test
npm run package
```

Install the generated `kettle-0.1.1.vsix`:

```sh
code --install-extension kettle-0.1.1.vsix --force
# or
cursor --install-extension kettle-0.1.1.vsix --force
```

Reload the editor, then open the command palette and run **Kettle: Ping Core**.
By default the extension attaches to a healthy local core or starts `kettle`
on port `4242`.

If auto-start cannot locate the CLI, set `kettle.command` to its absolute path,
for example `~/.local/bin/kettle`.

## Color themes

The extension ships **Kettle Dark** and **Kettle Light** plus the six glaze
packs — Cerise, Nectar, Artichaut, Marseille, Cobalt, Graphite — each in both
modes (14 themes), projected from the core product palette
(`kettle-core/kettle/static/kettle-palette.json` and the `kettle-*.json` packs
beside it). With a sibling core checkout, or `KETTLE_PALETTE` pointing at the
palette file:

```sh
npm run sync-palette    # regenerate themes/*.json and package.json contributes.themes
npm run check-palette   # fail if committed themes drift
```

In a glaze pack the enamel is chrome only — cursor, focus ring, badges,
buttons, active tab and panel borders — never text. Text roles follow the
core `acc`: the pack's own accent for the cool packs, the marquee accent
for the warm ones. Selection takes the pack's wash, because VS Code gives no
selection foreground. Surfaces are the measured shade steps from the palette
(`resolved`), not mixes. The palette library lives outside kettle-core;
see that repo's `docs/THEMES.md`.

## Develop

```sh
npm ci
npm run compile
```

Press `F5` to launch an Extension Development Host. The tests exercise path
matching, core discovery, compatibility checks, confirmation cards, activity
state, and the shared ritual rules (Approve, Comment, Not this, Finish batch):

```sh
npm test
```

Core owns the canonical visible copy used by every viewport — labels, hints and
the per-state status lines. Refresh the generated TypeScript snapshot after
`kettle-core/kettle/static/ui-copy.json` changes:

```sh
KETTLE_SRC=../kettle-core npm run sync-ui-copy
npm run check-ui-copy
```

To sync from a core branch without checking it out, export the file and point
`KETTLE_UI_COPY` at it:

```sh
git -C ../kettle-core show origin/main:kettle/static/ui-copy.json > /tmp/ui-copy.json
KETTLE_UI_COPY=/tmp/ui-copy.json npm run sync-ui-copy
```

Extension-owned text (notifications, command titles, settings descriptions)
uses the same plain words: project, file, summary, decision, Finish batch.

See [`DESK.md`](./docs/DESK.md) for the viewport boundary and
[`DEBUG.md`](./docs/DEBUG.md) for live-host diagnostics.
Release-facing changes are recorded in [`CHANGELOG.md`](./CHANGELOG.md).

## Trust and data

Kettle is workspace-scoped and does not run in untrusted workspaces. The
extension can start a local core and can read or write files inside projects
registered with that core. It does not bundle a model provider or send project
data by itself; provider execution is configured in core.

Please report vulnerabilities privately as described in
[`SECURITY.md`](./SECURITY.md).

## Contributing

Bug reports and focused pull requests are welcome. Read
[`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a change.

## License

[MIT](./LICENSE)
