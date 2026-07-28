/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: kettle-core static/ui-copy.js (or legacy setsweep-core)
 * Regenerate: npm run sync-ui-copy
 *
 * Canonical sitting UI copy for the Desk webview.
 */
export const UI_COPY = {
  streamIdle: "Chat stream idle",
  chatPlaceholder: "Chat with the Kettle agent…",
  chatPlaceholderFounding: "Chat with the Kettle agent…",
  chatPlaceholderProposing: "Ask to revise the proposal — or edit it, then Found Desk",
  editorPlaceholder: "",
  editorPlaceholderFounding: "Founding Interview — work in the agent pane on the right",
  editorPlaceholderProposing: "Desk Proposal — edit, then use Found Desk",
  commentPlaceholder: "a note for the sweep, tied to this file — Enter saves · Shift+Enter newline · Esc cancels",
  foundingQueueHintTitle: "Founding",
  foundingQueueHintBody: "The curator is in the agent pane. Answer there, then Draft Proposal ✓ when ready. The queue fills after you use Found Desk on the proposal.",
  proposingQueueHintTitle: "Desk Proposal",
  proposingQueueHintBody: "Edit the proposal in the editor until it matches your project, needs, and expectations. Chat with the curator to revise or co-write. Press Found Desk only when it feels right — that founds the desk and stocks the first queue.",
  noEntryBriefBody: "The Kettle file panel contains a batch of files for you to review, edit, approve, and sweep when the batch is finished.",
  addProjectTitle: "Add Project",
  addProjectNote: "Name a folder under your home. The interview starts in the agent pane — finish ✓ drafts a proposal you edit, then use Found Desk.",
  addProjectStart: "Start Interview",
} as const;

export type UiCopyKey = keyof typeof UI_COPY;
