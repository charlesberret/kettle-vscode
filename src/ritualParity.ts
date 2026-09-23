import * as path from "node:path";
import type { QueueEntry } from "./api";
import { entryAbsolutePath } from "./project";
import type { FoundingPhase } from "./state";

export type RitualControls = {
  interviewing: boolean;
  proposing: boolean;
  canApprove: boolean;
  canComment: boolean;
  canSweep: boolean;
  approveLabel: "Approve" | "Found Desk";
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
 * Resolve the one proposal queue entry that Found desk is allowed to approve.
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
}): RitualControls {
  const interviewing = input.phase === "interviewing";
  const proposing = input.phase === "proposing";
  const canFileAct = input.hasEntry && !interviewing && !input.streaming;
  return {
    interviewing,
    proposing,
    canApprove: proposing
      ? input.hasEntry && !input.streaming
      : canFileAct && !input.approved,
    canComment: canFileAct && !proposing,
    canSweep:
      input.hasProject && !interviewing && !proposing && !input.streaming,
    approveLabel: proposing ? "Found Desk" : "Approve",
  };
}
