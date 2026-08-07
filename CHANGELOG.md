# Changelog

## Unreleased

### Fixed

- Do not open the project QuickPick (or warn) on every window load when the
  open folder is not a registered Kettle desk. Auto-resolve stays silent;
  pick/register only when the user chooses Select Project or runs a desk
  command that needs a bound project. Unregistered folders leave the Desk
  empty-state CTA idle until asked.

## 0.1.0

### Added

- Kettle Desk panel, curated Explorer queue, editor actions, chat participant,
  and language-model tools for VS Code and Cursor.
- Local core discovery and auto-start with compatibility validation.
- Shared visible-copy drift check against `kettle-core`.
- Packageable VSIX, CI, contribution guidance, and security policy.

### Compatibility

- The canonical command, configuration, and Desk identity are Kettle.
- Existing `.setsweep/` Desks and a compatible legacy core identity remain
  readable during the migration window.
- Existing Setsweep virtual-environment locations are fallback-only.

This is a pre-release source package and is not yet published to the Visual
Studio Marketplace.
