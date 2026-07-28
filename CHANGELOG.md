# Changelog

## 0.1.0

### Added

- Kettle Desk panel, curated Explorer queue, editor actions, chat participant,
  and language-model tools for VS Code and Cursor.
- Local core discovery and auto-start with compatibility validation.
- Shared visible-copy drift check against `kettle-core`.
- Packageable VSIX, CI, contribution guidance, and security policy.
- Settings reorganized into grouped sections (Agents & Models, Project,
  Workflow, Connection & Startup, Diagnostics) in the native Settings UI.
- `kettle.effort` now covers the full per-provider ladder, including `xhigh`
  and `ultra`.
- `kettle.sweepVerbosity` (quiet/normal/verbose), synced to core's own
  sweep-narration setting.
- `kettle.autoSweepOnQueueDone` to run Sweep automatically once the queue has
  no pending entries left.
- `kettle.logToFile` to opt out of the on-disk diagnostics mirror.
- Live **Kettle Debug** panel (Kettle Desk → Debug) mirroring the diagnostic
  log in real time, with error highlighting and a status-bar error badge.
- **Kettle: Copy Debug Report** command / panel button — copies identity +
  recent log lines as a Markdown block for pasting into a coding agent.
- Every user-facing error toast now also logs to the debug ring, so it shows
  up in the live panel and in Copy Debug Report — not just as a toast.

### Compatibility

- The canonical command, configuration, and Desk identity are Kettle.
- Existing `.setsweep/` Desks and a compatible legacy core identity remain
  readable during the migration window.
- Existing Setsweep virtual-environment locations are fallback-only.

This is a pre-release source package and is not yet published to the Visual
Studio Marketplace.
