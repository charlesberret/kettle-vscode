# Contributing to Kettle for VS Code

Thanks for helping improve Kettle's editor viewport.

## Before you start

- Search existing issues before opening a new one.
- Keep core behavior in
  [`kettle-core`](https://github.com/charlesberret/kettle-core). This repository
  should adapt the core contract to VS Code and Cursor rather than reimplement
  project, Desk, or sweep semantics.
- For a substantial feature or contract change, open an issue before writing
  the implementation.

## Development

Use Node.js 20 or newer:

```sh
npm ci
npm test
```

For live-host work, press `F5` in VS Code and follow [`DEBUG.md`](./DEBUG.md).

If a change affects user-visible copy shared with core, edit
`kettle-core/static/ui-copy.js` first and then run:

```sh
KETTLE_SRC=../kettle-core npm run sync-ui-copy
npm run check-ui-copy
```

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update tests for behavior changes.
- Run `npm test` and `npm run package`.
- Do not commit generated VSIX files, `dist/`, or `node_modules/`.

By contributing, you agree that your contribution is licensed under the
[MIT License](./LICENSE).
