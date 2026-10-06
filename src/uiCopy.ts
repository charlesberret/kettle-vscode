/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: kettle-core kettle/static/ui-copy.json
 * Regenerate: npm run sync-ui-copy
 *
 * Canonical sitting UI copy for the Desk webview. Every viewport resolves the same
 * keys, so a string changed in core reaches this one too.
 */
export const UI_COPY = {
  /** Agent pane status when no agent stream is running. */
  streamIdle: "Chat stream idle",
  /** Spinner label while an agent turn is in flight. */
  spinWorking: "Working…",
  /** Chat input placeholder on a founded desk. */
  chatPlaceholder: "Chat with the Kettle agent…",
  /** Chat input placeholder during the founding interview (P3). */
  chatPlaceholderFounding: "Chat with the Kettle agent (recommended)",
  /** Chat input placeholder while a Desk Proposal is on the editor (P4). */
  chatPlaceholderProposing: "Ask the agent to revise the proposal",
  /** Editor placeholder on a founded desk with no entry open. Intentionally empty. */
  editorPlaceholder: "",
  /** Editor placeholder during the founding interview; the editor is not the work surface yet. */
  editorPlaceholderFounding: "Chat with the agent to establish your project.",
  /** Editor placeholder when the Desk Proposal is the open document. */
  editorPlaceholderProposing: "Edit the proposal, then approve it to set up your project",
  /** Comment box placeholder, including its key bindings. */
  commentPlaceholder: "A note on this file for the agent to read when you finish this batch — Enter saves · Shift+Enter newline · Esc cancels",
  /** Queue empty-state hed during the founding interview. */
  foundingQueueHintTitle: "Setting up",
  /** Queue empty-state body during founding — says where the work is and what fills the queue. */
  foundingQueueHintBody: "Chat with the Kettle agent to set up your project with a queue of files to review.",
  /** Queue empty-state hed while a proposal awaits Approve. */
  proposingQueueHintTitle: "Proposal",
  /** Queue empty-state body while proposing. The short form is what a status bar shows. */
  proposingQueueHintBody: "Edit the proposal until it matches what you want from this project. Chat with the agent to revise it or write it together. When it looks right, approve it — that sets up your project and lines up the first batch of files to review.",
  /** Second line of the brief when a project desk is bound and no queue entry is selected. */
  noEntryBriefBody: "Kettle lines up a batch of files for you to review, edit, and approve. When you are done, press Finish batch: the agent applies your decisions and lines up the next one.",
  /** Hed of the queue pane (left column, top). */
  queueTitle: "Queue",
  /** Hed of the entry-metadata pane (left column, bottom). */
  metaTitle: "Info",
  /** Button in the Info pane hed that switches entry fields to editable. */
  metaEditLabel: "Edit",
  /** Label beside the project selector in the desk chrome. */
  deskProjectLabel: "Project",
  /** Ritual control: rules on the open entry. Reads Approve in both states — while a proposal is open, pressing it founds the project desk. */
  approveLabel: "Approve",
  /** The same control while proposing. Same word since 2026-10-01; kept as its own key so a viewport may still differ if it needs to. */
  approveLabelFounding: "Approve",
  /** Tooltip on Approve. States what it does not do, which is the common misread. */
  approveHint: "Mark your decision on this file. Nothing changes until you press Finish batch.",
  /** Tooltip on the ritual control while a proposal is open. The label does not change (Approve was retired 2026-10-01); the sitting promotes the control visually instead. */
  approveHintFounding: "Approve the proposal to set up your project",
  /** Ritual button: open the note box for the open file. */
  commentLabel: "Comment",
  /** Tooltip on Comment. */
  commentHint: "Leave a note on this file for the agent to act on",
  /** Hint under the comment box, explaining when the note is consumed. */
  commentTiedHint: "This note stays with the file. The agent reads it when you finish the batch.",
  /** Button that commits the comment box. */
  commentSaveLabel: "Save",
  /** Ritual control: set this file aside. One click, no explanation asked — the agent works out whether you meant this file or this kind of file, and says what it took from it in the next round notes. */
  notThisLabel: "Not this",
  /** Tooltip on Not this. */
  notThisHint: "Set this file aside. The agent takes it as a sign of what you don't want, and tells you what it learned when you finish the batch.",
  /** The same control on a file already set aside. */
  notThisUndoLabel: "Bring back",
  /** Tooltip on Bring back. */
  notThisUndoHint: "Put this file back in the batch",
  /** The button that ends a batch. Internally this is a sweep; the word stays off screen. */
  sweepLabel: "Finish batch",
  /** Tooltip on Finish batch: the full list of what finishing does. */
  sweepHint: "Apply your decisions, review what changed, note anything else it affects, and line up the next files",
  /** Finish batch, relabelled during the 3-second window when confirmation is off; pressing it cancels. */
  sweepUndoLabel: "Undo",
  /** Status strip under the project bar while the founding interview runs. Title Case as a hed (docs/UI.md); the term is lowercase in prose. */
  foundingHeadTitle: "Setting up your project",
  /** Ends the founding interview early and writes the Desk Proposal. */
  draftProposalLabel: "Auto: let the Kettle agent decide",
  /** Tooltip on Draft Proposal ✓. */
  draftProposalHint: "Skip the rest of the questions and let the agent write the proposal now",
  /** Leaves founding for later and opens the project as-is. */
  skipFoundingLabel: "Skip: open a blank project for now",
  /** Tooltip on skip for now. Names the cost (no charter, no queue) and how to resume. */
  skipFoundingHint: "Set this up later — open the project now, with no files lined up",
  /** Hed of the sweep confirmation dialog. */
  sweepConfirmTitle: "Finish This Batch?",
  /** Body of the sweep confirmation — the authoritative description of what a sweep does. */
  sweepConfirmBody: "Applies the decisions you marked, reviews what changed in each file, notes anything else it affects, saves a record of this round, and lines up the next batch.",
  /** Placeholder for the optional free-text steer on the sweep dialog. */
  sweepThrustPlaceholder: "Anything on your mind as you finish? The agent reads this first (optional)",
  /** Hed of the add-project dialog. */
  addProjectTitle: "Add Project",
  /** Body of the add-project dialog — sets up what happens after Start Interview. */
  addProjectNote: "Name the project folder",
  /** Button that registers the project and opens founding (P1 to P3). Title Case: docs/UI.md lists it among the signature actions that are also titles. */
  addProjectStart: "Start Interview",
  /** Placeholder for the project's display name. */
  addProjectNamePlaceholder: "Name",
  /** Placeholder for the project root. */
  addProjectFolderPlaceholder: "Folder path",
  /** The one mission question of registration (P1). Founding is a conversation, not a confirmation card — see docs/REVIEW.md. */
  addProjectFoundingQuestion: "What's the state of this project and how could a second reader help?",
  /** Example answer to the founding question. An example, not an instruction. */
  addProjectFoundingPlaceholder: "Example: \"This project is growing quickly. Start by flagging anything that looks stale or contradictory.\"",
  /** Hed of the re-found dialog. */
  refoundTitle: "Set up this project again?",
  /** Hed of the first-run agent setup dialog. */
  setupTitle: "Kettle",
  /** Body of first-run setup. The key promise (no stored keys) must survive any rewrite. */
  setupNote: "Pick the agent that runs setup, chat, and reviews. Kettle never stores keys. Sign in with your browser or set the API key in your shell.",
  /** Placeholder status while first-run setup probes the selected CLI. */
  setupChecking: "Checking agent…",
} as const;

/**
 * Terse variants for a surface too narrow for the full string. Same meaning, fewer
 * words — never a different instruction. Absent keys fall back to UI_COPY.
 */
export const UI_COPY_SHORT: Partial<Record<UiCopyKey, string>> = {
  streamIdle: "Agent idle",
  spinWorking: "Working",
  chatPlaceholder: "Chat",
  chatPlaceholderFounding: "Chat with the agent",
  chatPlaceholderProposing: "Revise, then approve",
  editorPlaceholderProposing: "Edit the proposal, then approve it",
  commentPlaceholder: "Note for the agent",
  foundingQueueHintBody: "Chat with the agent to set up your project.",
  proposingQueueHintBody: "Edit the proposal, then approve it to set up your project.",
  noEntryBriefBody: "A batch of files to review, edit, and approve.",
  approveLabel: "approve",
  approveHint: "Mark your decision on this file.",
  approveHintFounding: "Edit and approve the proposal",
  commentHint: "Leave a note for the agent",
  commentTiedHint: "The agent reads this when you finish the batch",
  notThisHint: "Set this file aside",
  sweepLabel: "Finish",
  sweepHint: "Apply your decisions and line up the next files",
  draftProposalLabel: "Auto-mode",
  draftProposalHint: "Skip the interview",
  skipFoundingLabel: "Skip interview",
  skipFoundingHint: "Set this up later",
  sweepConfirmTitle: "Finish now?",
  sweepConfirmBody: "Applies your decisions, reviews the batch, saves a record, and lines up the next files.",
  sweepThrustPlaceholder: "Anything on your mind? (optional)",
  addProjectTitle: "Add project",
  addProjectStart: "Start",
  refoundTitle: "Set up again?",
  setupNote: "Pick the agent Kettle will run. Kettle never stores API keys.",
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

/**
 * One message per flow state (kettle-core docs/SITTING-FLOWS.md §7), in three
 * registers of the same message: `line` for a status bar, `short` for one
 * sentence, `full` for a guide. Never author a sentence for a state listed here.
 */
export const UI_STATES = {
  attached: {
    line: "Pick a file",
    short: "Pick a file to begin.",
    full: "Kettle has lined up a batch of files for you. Pick one to read it with the agent's summary. Mark your decisions as you go, then press Finish batch when you are done.",
  },
  interviewing: {
    line: "Chat with the agent",
    short: "Chat with the Kettle agent; when you are done it drafts a proposal to review.",
    full: "Chat with the Kettle agent to tell it what this project is and what you want from a second reader. When you are ready to proceed, the agent writes a proposal for you to review and edit. The queue fills after you approve the proposal.",
  },
  proposing: {
    line: "Edit the proposal",
    short: "Edit the proposal, then approve it to set up your project.",
    full: "The proposal is open in the editor. This is the document of record for your Kettle project. Read it, change anything that does not fit, and chat with the agent to revise or co-write.",
  },
  founding: {
    line: "Setting up…",
    short: "Setting up your project…",
    full: "The agent is setting up your project and lining up the first batch of files from your proposal. This may take a few minutes.",
  },
  founded: {
    line: "Ready to begin",
    short: "Your project is ready. Pick a file to begin.",
    full: "Your project is set up and the first batch of files is ready. Pick one to read it with the agent's summary, edit and comment as you go, then press Finish batch when you are done.",
  },
  sweeping: {
    line: "Finishing the batch…",
    short: "Applying your decisions and lining up the next batch.",
    full: "The agent is applying your decisions, reviewing what changed, noting anything else it affects, saving a record of this round, and lining up the next batch.",
  },
  broken: {
    line: "This project needs attention.",
    short: "Kettle could not open this project. Nothing has been changed.",
    full: "Kettle could not open this project. Its folder may have moved, or its records may be unreadable. Nothing has been changed on disk. Check the project folder, or set the project up again — your own files are never touched.",
  },
} as const;

export type UiStateName = keyof typeof UI_STATES;
export type UiStateRegister = "line" | "short" | "full";

/**
 * The message for `state` in the register the surface affords. A missing register
 * falls back to the longest one present: too many words beats none.
 */
export function uiState(state: UiStateName, register: UiStateRegister = "short"): string {
  return pickStateRegister(UI_STATES[state], register);
}

/** The register asked for, else the longest one present. */
export function pickStateRegister(
  rec: Partial<Record<UiStateRegister, string>>,
  register: UiStateRegister,
): string {
  const own = rec[register];
  if (own) return own;
  for (const r of ["full", "short", "line"] as const) {
    if (rec[r]) return rec[r] as string;
  }
  return "";
}
