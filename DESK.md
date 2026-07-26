# Desk panel — structure for contributors

The Kettle **Desk** is the primary sitting surface in the editor host. It lives
in the **Secondary Side Bar** (opposite Explorer) and is implemented almost
entirely in one module:

| Layer | File | Role |
|-------|------|------|
| Host glue | `src/extension.ts` | Commands, project resolve, HTTP via `api.ts`, injects `DeskPanelDeps` |
| Webview shell | `src/deskPanel.ts` | HTML/CSS/JS template + message protocol; ritual UI |
| Sitting state | `src/state.ts` + `src/ritualParity.ts` | Ephemeral selection and tested canonical ritual decisions — not a desk DB |
| Confirm cards | `src/confirmCard.ts` | Parse/serialize founding GFM checklists |
| Queue list | `src/queueView.ts` | Explorer TreeView — relative paths, file icons, approved last, Approve inline/context |
| Editor chrome | `package.json` menus + `extension.ts` context keys | Title-bar Approve/Comment/Sweep; keybindings `⌘⇧A` / `⌘⇧;` / `⌘⇧Enter` |

Core owns the desk on disk (`.kettle/`) and the HTTP contract (`kettle-core/API.md`).
This package is a viewport.

## Ritual actions (do not invent peers)

| Button | Core route | Meaning |
|--------|------------|---------|
| **Approve** | `POST /api/approve` | Bookmark a ruling — **not** apply/commit |
| **Found desk** (Approve while proposing) | `POST /api/approve` then `POST /api/found` | Accept the edited `DESK-PROPOSAL.md` and found the desk |
| **Comment** | `POST /api/comment` | Send-back note on the entry |
| **Sweep** | `POST /api/sweep` | Commit pass for the sitting (optional thrust) |

Ritual order is **decision-first: Approve · Comment · Sweep**, left-aligned
(side-agnostic — Desk may sit in either sidebar). Gap between buttons is
roomy by default and collapses as the panel narrows. Comment opens a drawer
**under** the ritual bar into the chat stream (not above the buttons).

**Header chrome:** project selector pill + settings gear + **chat model pill**
(from `GET /api/curator/catalog` / `POST /api/curator`). “Browse all…” on the
project menu falls back to host QuickPick. No bullseye jump control
(selection follows the active editor; `kettle.jumpActive` remains).

**Brief block:** takeaway quote first (curator `ask`, unlabeled), then full brief.

**Ritual enablement** (aligned with core midfoot): Approve/Comment need an open
entry; Approve off when already approved (except proposing); Sweep needs a
project and stands down while founding/proposing/streaming.

Open file = click the path (or Explorer queue). Status/urgency tags, secondary
project labels, and the plugin version stamp stay out of the Desk header.

## Webview message types (webview → host)

`ready` · `approve` · `comment` · `sweep` · `chat` · `compact` · `cancel` ·
`confirmCard` · `settings` · `openEntry` · `refreshDiff` · `selectProject`
(`projectId` optional — omit for host QuickPick) · `refreshProjects`

(`jumpActive` remains a command-palette command; the bullseye header control was removed.)
Founding interview is started from the host toast or **Kettle: Begin Founding Interview**,
not a Desk ritual button.

Host → webview: `state` (includes `projects[]` and tested `ritual` enablement) ·
`stream` · `activity` · `foundingView` · `streaming` · `freeze` · `ritualZoom`.

## Empty states

- **No project** — show Select project CTA + `kettle add` hint (`body.needs-project`).
- **Project, no entry** — brief invites Explorer selection; ritual Approve/Comment disabled.
- **Interviewing** — hide ritual; show confirm-card pane (start via toast / command).
- **Proposing** — hide Comment/Sweep; show pulsing **Found desk** (Approve) + brief that says edit → Found desk.

Before Found desk calls `/api/approve`, host glue resolves the proposal entry and saves
only the dirty `DESK-PROPOSAL.md` editor buffer. A missing proposal or failed save stops
both approve and `/api/found`.

## Build id

`DESK_UI_BUILD` / `debug.BUILD_ID` still come from `package.json` `version` and
show up in **Kettle: Debug** / the debug log — not as chrome on the Desk.
