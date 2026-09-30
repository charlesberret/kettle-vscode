/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: kettle-core kettle/static/ui-copy.json
 * Regenerate: npm run sync-ui-copy
 *
 * Canonical sitting UI copy for the Desk webview. Every viewport resolves the same
 * keys, so a string changed in core reaches this one too.
 */
export const UI_COPY = {
  /** Agent pane status when no curator stream is running. */
  streamIdle: "Chat stream idle",
  /** Spinner label while a curator turn is in flight. */
  spinWorking: "working…",
  /** Chat input placeholder on a founded desk. */
  chatPlaceholder: "Chat with the Kettle agent…",
  /** Chat input placeholder during the founding interview (P3). */
  chatPlaceholderFounding: "Chat with the Kettle agent…",
  /** Chat input placeholder while a Desk Proposal is on the editor (P4). */
  chatPlaceholderProposing: "Ask to revise the proposal — or edit it, then Found Desk",
  /** Editor placeholder on a founded desk with no entry open. Intentionally empty. */
  editorPlaceholder: "",
  /** Editor placeholder during the founding interview; the editor is not the work surface yet. */
  editorPlaceholderFounding: "Founding Interview — work in the agent pane on the right",
  /** Editor placeholder when the Desk Proposal is the open document. */
  editorPlaceholderProposing: "Desk Proposal — edit, then use Found Desk",
  /** Comment box placeholder, including its key bindings. */
  commentPlaceholder: "a note for the sweep, tied to this file — Enter saves · Shift+Enter newline · Esc cancels",
  /** Queue empty-state hed during the founding interview. */
  foundingQueueHintTitle: "Founding",
  /** Queue empty-state body during founding — says where the work is and what fills the queue. */
  foundingQueueHintBody: "The curator is in the agent pane. Answer there, then Draft Proposal ✓ when ready. The queue fills after you use Found Desk on the proposal.",
  /** Queue empty-state hed while a proposal awaits Found Desk. */
  proposingQueueHintTitle: "Desk Proposal",
  /** Queue empty-state body while proposing. The short form is what a status bar shows. */
  proposingQueueHintBody: "Edit the proposal in the editor until it matches your project, needs, and expectations. Chat with the curator to revise or co-write. Press Found Desk only when it feels right — that founds the desk and stocks the first queue.",
  /** Second line of the Desk brief when a project is bound but no queue entry is selected. */
  noEntryBriefBody: "The Kettle file panel contains a batch of files for you to review, edit, approve, and sweep when the batch is finished.",
  /** Hed of the queue pane (left column, top). */
  queueTitle: "Queue",
  /** Hed of the entry-metadata pane (left column, bottom). */
  metaTitle: "Info",
  /** Button in the Info pane hed that switches entry fields to editable. */
  metaEditLabel: "edit",
  /** Label beside the project selector in the desk chrome. */
  deskProjectLabel: "Project",
  /** Ritual button: bookmark a ruling on the open entry. Becomes approveLabelFounding while proposing. */
  approveLabel: "Approve",
  /** The same ritual button while a Desk Proposal is open — pressing it founds the desk (P4 → founded). */
  approveLabelFounding: "Found Desk",
  /** Tooltip on Approve. States what it does not do, which is the common misread. */
  approveHint: "Bookmark a ruling — does not apply or commit",
  /** Tooltip on the ritual button while it reads Found Desk (proposing). */
  approveHintFounding: "Found this desk from your edited proposal",
  /** Ritual button: open the note box for the open file. */
  commentLabel: "Comment",
  /** Tooltip on Comment. */
  commentHint: "Leave a note on this file for the agent to address during the sweep",
  /** Hint under the comment box, explaining when the note is consumed. */
  commentTiedHint: "tied to this file; the sweep reads it when it closes the sitting",
  /** Button that commits the comment box. */
  commentSaveLabel: "save",
  /** Ritual button: close the sitting. */
  sweepLabel: "Sweep",
  /** Tooltip on Sweep — the full list of what closing does. */
  sweepHint: "close the sitting — apply rulings, diff & assess the batch, fix/flag ripples, log the session, restock the queue",
  /** Status strip under the project bar while the founding interview runs. */
  foundingHeadTitle: "founding interview",
  /** Ends the interview early and drafts the Desk Proposal (P3 → P4). The ✓ is part of the label. */
  draftProposalLabel: "Draft Proposal ✓",
  /** Tooltip on Draft Proposal ✓. */
  draftProposalHint: "skip remaining chat and draft the desk proposal now",
  /** Leaves founding for later and opens the project as-is. */
  skipFoundingLabel: "skip for now",
  /** Tooltip on skip for now. Names the cost (no charter, no queue) and how to resume. */
  skipFoundingHint: "leave founding for later — open the project as-is (no charter or queue yet); reselect it to resume founding",
  /** Hed of the sweep confirmation dialog. */
  sweepConfirmTitle: "Sweep the Desk?",
  /** Body of the sweep confirmation — the authoritative description of what a sweep does. */
  sweepConfirmBody: "Closes the sitting: applies ticked rulings (launches become logged directives), diffs and assesses every reviewed entry, fixes or flags ripples, writes the session log, and restocks the queue.",
  /** Placeholder for the optional free-text steer on the sweep dialog. */
  sweepThrustPlaceholder: "a steer for this pass — what's most on your mind as you close the sitting. the agent reads it first (optional · ⌘Enter sweeps)",
  /** Hed of the add-project dialog. */
  addProjectTitle: "Add Project",
  /** Body of the add-project dialog — sets up what happens after Start Interview. */
  addProjectNote: "Name a folder under your home. The interview starts in the agent pane — Draft Proposal ✓ drafts a proposal you edit, then use Found Desk.",
  /** Button that registers the project and opens founding (P1 to P3). Title Case: docs/UI.md lists it by name among the signature actions that are also titles, beside Found Desk and Draft Proposal. The web markup read 'start interview' until 2026-09-30, so the sitting and the VS Code mirror disagreed. */
  addProjectStart: "Start Interview",
  /** Placeholder for the project's display name. */
  addProjectNamePlaceholder: "name",
  /** Placeholder for the project root. */
  addProjectFolderPlaceholder: "folder (absolute or ~/ path)",
  /** The one mission question of registration (P1). Founding is a conversation, not a confirmation card — see docs/REVIEW.md. */
  addProjectFoundingQuestion: "In a sentence or two: what is this, and what do you want from a second reader here?",
  /** Example answer to the founding question. An example, not an instruction. */
  addProjectFoundingPlaceholder: "e.g. a research folder that grows fast — flag anything that looks stale or contradicts what's already written",
  /** Hed of the re-found dialog. */
  refoundTitle: "Re-found this project?",
  /** Hed of the first-run curator setup dialog. */
  setupTitle: "Kettle",
  /** Body of first-run setup. The key promise (no stored keys) must survive any rewrite. */
  setupNote: "Pick the agent CLI that runs founding, chat, and sweeps. Kettle never stores API keys — sign in to the CLI or set its key in your shell.",
  /** Placeholder status while first-run setup probes the selected CLI. */
  setupChecking: "checking curator…",
} as const;

/**
 * Terse variants for a surface too narrow for the full string. Same meaning, fewer
 * words — never a different instruction. Absent keys fall back to UI_COPY.
 */
export const UI_COPY_SHORT: Partial<Record<UiCopyKey, string>> = {
  streamIdle: "idle",
  spinWorking: "working",
  chatPlaceholder: "chat",
  chatPlaceholderFounding: "answer the curator",
  chatPlaceholderProposing: "revise, or Found Desk",
  editorPlaceholderFounding: "founding — work in the agent pane",
  editorPlaceholderProposing: "edit, then Found Desk",
  commentPlaceholder: "note for the sweep",
  foundingQueueHintBody: "Answer the curator in the agent pane, then Draft Proposal ✓.",
  proposingQueueHintBody: "Edit the proposal until it matches your intent, then Found Desk.",
  noEntryBriefBody: "A batch of files to review, edit, approve, then sweep.",
  queueTitle: "Q",
  approveLabel: "approve",
  approveLabelFounding: "found",
  commentLabel: "comment",
  commentTiedHint: "the sweep reads this",
  sweepLabel: "sweep",
  sweepHint: "close the sitting",
  foundingHeadTitle: "founding",
  draftProposalLabel: "draft proposal",
  sweepConfirmBody: "Applies rulings, assesses the batch, logs the session, restocks the queue.",
  sweepThrustPlaceholder: "a steer for this pass (optional)",
  addProjectNote: "Name a folder; the interview starts in the agent pane.",
  addProjectStart: "start",
  addProjectFoundingQuestion: "What is this, and what do you want from a second reader?",
  setupNote: "Pick the agent CLI. Kettle never stores API keys.",
};

export type UiCopyKey = keyof typeof UI_COPY;

/** The string for `key`, preferring the short variant when the surface is narrow. */
export function uiCopy(key: UiCopyKey, opts?: { short?: boolean }): string {
  if (opts?.short) {
    const s = UI_COPY_SHORT[key];
    if (s) return s;
  }
  return UI_COPY[key];
}
