import * as path from "node:path";
import type { QueueEntry } from "./api";
import { entryAbsolutePath } from "./project";
import type { DeskActivity, FoundingPhase } from "./state";
import { uiCopy, uiState, type UiStateName } from "./uiCopy";

/**
 * The four ritual controls — Approve, Comment, Not this, Finish batch — with
 * enablement and every on-screen word, all from core's catalog. The webview
 * renders this; it does not compute a label of its own.
 */
export type RitualControls = {
  interviewing: boolean;
  proposing: boolean;
  canApprove: boolean;
  canComment: boolean;
  canNotThis: boolean;
  canSweep: boolean;
  /** Same word in every phase: "Found Desk" was retired by core on 2026-10-01. */
  approveLabel: string;
  approveHint: string;
  commentLabel: string;
  commentHint: string;
  /** True when the open file is already set aside: the control reads Bring back. */
  notThisUndo: boolean;
  notThisLabel: string;
  notThisHint: string;
  sweepLabel: string;
  /** The catalog's short form, for a panel too narrow for the full label. */
  sweepLabelShort: string;
  sweepHint: string;
  sweepUndoLabel: string;
};

/**
 * Founding phase from the core's `GET /api/interview` beacon.
 *
 * `founded` is the core's predicate (charter on disk AND a content entry). Older
 * cores do not send it; fall back to `status`, never to `has_entries` — entries
 * alone do not found a desk, and a found run that files entries but fails to
 * write `PROJECT.md` must stay in founding. kettle-core `docs/SITTING-FLOWS.md` §3.
 */
export function foundingPhaseFrom(iv: {
  status?: string;
  founded?: boolean;
  has_proposal?: boolean;
}): FoundingPhase {
  if (iv.founded === true) return "founded";
  if (iv.founded === undefined && iv.status === "founded") return "founded";
  if (iv.status === "proposing" || iv.has_proposal) return "proposing";
  if (iv.status === "interviewing") return "interviewing";
  return "none";
}

/**
 * Canonical web rule: only the interview phase uses /api/interview.
 * Proposal revision chat is ordinary project chat and must not regress the
 * phase back to interviewing.
 */
export function chatModeForPhase(
  phase: FoundingPhase,
): "interview" | "chat" {
  return phase === "interviewing" ? "interview" : "chat";
}

/** Identify the proposal placeholder using the same signals as core web. */
export function isProposalEntry(entry: QueueEntry | undefined): boolean {
  if (!entry) return false;
  if (String(entry.id) === "desk-proposal" || entry.founding_phase === "proposal") {
    return true;
  }
  const p = String(entry.path || "").replace(/\\/g, "/");
  return p.endsWith("/DESK-PROPOSAL.md") || p === "DESK-PROPOSAL.md";
}

/**
 * Resolve the one proposal queue entry that approving the proposal may act on.
 * During proposing, a stale ordinary selection must never be approved by mistake.
 */
export function proposalEntryForFounding(
  entries: QueueEntry[],
  selected: QueueEntry | undefined,
  proposing: boolean,
): QueueEntry | undefined {
  if (isProposalEntry(selected)) return selected;
  return proposing ? entries.find(isProposalEntry) : undefined;
}

/**
 * Resolve the exact document to save before founding. A malformed proposal
 * placeholder falls back to the canonical desk path, never the selected file.
 */
export function proposalDocumentPath(
  entry: QueueEntry,
  projectRoot: string,
): string | undefined {
  if (!isProposalEntry(entry)) return undefined;
  const entryPath = String(entry.path || "");
  if (path.basename(entryPath.replace(/\\/g, "/")) === "DESK-PROPOSAL.md") {
    return entryAbsolutePath(entryPath, projectRoot);
  }
  return path.join(projectRoot, ".kettle", "DESK-PROPOSAL.md");
}

/** Current core must explicitly confirm a session before POST /api/compact. */
export function shouldPostCompact(status: { has_session?: boolean }): boolean {
  return status.has_session === true;
}

/**
 * Host-side copy of the canonical ritual enablement bar. The webview consumes
 * this result instead of maintaining a second phase formula in template JS.
 */
export function ritualControls(input: {
  phase: FoundingPhase;
  hasProject: boolean;
  hasEntry: boolean;
  approved: boolean;
  streaming: boolean;
  /** The open file's status is `set-aside`. */
  setAside?: boolean;
  /** The open file is the proposal (core refuses Not this on it). */
  isProposal?: boolean;
}): RitualControls {
  const interviewing = input.phase === "interviewing";
  const proposing = input.phase === "proposing";
  const canFileAct = input.hasEntry && !interviewing && !input.streaming;
  const notThisUndo = !!input.setAside;
  return {
    interviewing,
    proposing,
    canApprove: proposing
      ? input.hasEntry && !input.streaming
      : canFileAct && !input.approved,
    canComment: canFileAct && !proposing,
    canNotThis: canFileAct && !proposing && !input.isProposal,
    canSweep:
      input.hasProject && !interviewing && !proposing && !input.streaming,
    approveLabel: uiCopy("approveLabel"),
    approveHint: uiCopy(proposing ? "approveHintFounding" : "approveHint"),
    commentLabel: uiCopy("commentLabel"),
    commentHint: uiCopy("commentHint"),
    notThisUndo,
    notThisLabel: uiCopy(notThisUndo ? "notThisUndoLabel" : "notThisLabel"),
    notThisHint: uiCopy(notThisUndo ? "notThisUndoHint" : "notThisHint"),
    sweepLabel: uiCopy("sweepLabel"),
    sweepLabelShort: uiCopy("sweepLabel", { short: true }),
    sweepHint: uiCopy("sweepHint"),
    sweepUndoLabel: uiCopy("sweepUndoLabel"),
  };
}

/**
 * The catalog state that describes the desk (kettle-core docs/SITTING-FLOWS.md §7),
 * or undefined when there is nothing to say beyond the project's name. A running
 * stream outranks the phase it runs in; a broken desk outranks everything.
 */
export function deskStateName(input: {
  connected: boolean;
  hasProject: boolean;
  phase: FoundingPhase;
  activity: DeskActivity;
  hasEntry?: boolean;
}): UiStateName | undefined {
  if (!input.connected || !input.hasProject) return undefined;
  if (input.activity === "broken") return "broken";
  if (input.activity === "sweeping") return "sweeping";
  if (input.activity === "founding") return "founding";
  if (input.phase === "interviewing") return "interviewing";
  if (input.phase === "proposing") return "proposing";
  if (input.phase === "founded" && !input.hasEntry) return "attached";
  return undefined;
}

/**
 * The status bar text. A state the catalog covers is rendered in its `line`
 * register; otherwise the project's name. Never a sentence of our own for a state.
 */
export function deskStatusLine(input: {
  connected: boolean;
  hasProject: boolean;
  projectName?: string;
  phase: FoundingPhase;
  activity: DeskActivity;
  hasEntry?: boolean;
}): string {
  if (!input.connected) return OFFLINE_LINE;
  if (!input.hasProject) return NO_PROJECT_LINE;
  const name = deskStateName(input);
  if (name && name !== "attached") return uiState(name, "line");
  return input.projectName || "";
}

/** Not catalog states: the viewport has no core to read a state from. */
export const OFFLINE_LINE = "Offline — start Kettle with kettle --web";
export const NO_PROJECT_LINE = "No project selected";
