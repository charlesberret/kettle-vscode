# Kettle for VS Code / Cursor

**Product home (star there):** [github.com/charlesberret/kettle](https://github.com/charlesberret/kettle)

Editor viewport for **Kettle** — curated queue, Desk panel, approve / comment / sweep.
Same extension for **VS Code** and **Cursor** (one VSIX).

This repo is an **adapter**. Core, CLI, kits, and the reference web UI live in the
[kettle](https://github.com/charlesberret/kettle) home repo (local: `../kettle`).

## Status

Scaffold **0.1.0** lifted from the Setsweep VS Code package and rebranded. Still
talks to a live core on `:4242` (accepts cores that identify as `kettle` *or*
legacy `setsweep`). Desk paths prefer `.kettle/`, fall back to `.setsweep/`.

## Setup

1. Core: install from the kettle home repo when ready, or keep using setsweep-core
   during transition (`~/.setsweep-venv` is still discovered).
2. From this repo:

```sh
npm install
npm test
npm run package   # → kettle-0.1.0.vsix
cursor --install-extension kettle-0.1.0.vsix --force
```

3. Reload the window. Command palette: **Kettle: …**

## Develop

```sh
npm install
npm run compile
# F5 — Extension Development Host (see .vscode/launch.json)
```

UI-copy sync (when core tree exists):

```sh
# KETTLE_SRC=../kettle npm run sync-ui-copy   # when wired
```

Local design notes: `planning/` (gitignored).

## License

MIT — see the product home / upstream Setsweep lineage for full notices until
LICENSE is finalized here.
