import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatModeForPhase,
  foundingPhaseFrom,
  isProposalEntry,
  proposalDocumentPath,
  proposalEntryForFounding,
  deskStateName,
  deskStatusLine,
  NO_PROJECT_LINE,
  OFFLINE_LINE,
  ritualControls,
  shouldPostCompact,
} from "../ritualParity";
import { UI_COPY, UI_STATES } from "../uiCopy";

describe("canonical founding state machine", () => {
  it("routes only interviewing chat to /api/interview", () => {
    assert.equal(chatModeForPhase("none"), "chat");
    assert.equal(chatModeForPhase("interviewing"), "interview");
    assert.equal(chatModeForPhase("proposing"), "chat");
    assert.equal(chatModeForPhase("founded"), "chat");
  });

  it("recognizes proposal entries by id, phase, and normalized path", () => {
    assert.equal(
      isProposalEntry({ id: "desk-proposal", path: "anything.md" }),
      true,
    );
    assert.equal(
      isProposalEntry({
        id: "other",
        path: "anything.md",
        founding_phase: "proposal",
      }),
      true,
    );
    assert.equal(
      isProposalEntry({
        id: "other",
        path: "C:\\work\\.kettle\\DESK-PROPOSAL.md",
      }),
      true,
    );
    assert.equal(
      isProposalEntry({ id: "content", path: "docs/DESK-PROPOSAL-notes.md" }),
      false,
    );
  });

  it("resolves the proposal instead of a stale selected content entry", () => {
    const content = { id: "content", path: "docs/work.md" };
    const proposal = {
      id: "desk-proposal",
      path: ".kettle/DESK-PROPOSAL.md",
    };
    assert.equal(
      proposalEntryForFounding([content, proposal], content, true),
      proposal,
    );
    assert.equal(proposalEntryForFounding([content], content, true), undefined);
    assert.equal(proposalEntryForFounding([content, proposal], content, false), undefined);
  });

  it("resolves only the canonical proposal document path for saving", () => {
    assert.equal(
      proposalDocumentPath(
        { id: "desk-proposal", path: "anything.md" },
        "/work/alpha",
      ),
      "/work/alpha/.kettle/DESK-PROPOSAL.md",
    );
    assert.equal(
      proposalDocumentPath(
        { id: "desk-proposal", path: ".kettle/DESK-PROPOSAL.md" },
        "/work/alpha",
      ),
      "/work/alpha/.kettle/DESK-PROPOSAL.md",
    );
    assert.equal(
      proposalDocumentPath(
        { id: "content", path: "docs/work.md" },
        "/work/alpha",
      ),
      undefined,
    );
  });

  it("does not post compact when core reports no active session", () => {
    assert.equal(shouldPostCompact({ has_session: false }), false);
    assert.equal(shouldPostCompact({ has_session: true }), true);
    assert.equal(shouldPostCompact({}), false);
  });

  it("hides the ritual during interview", () => {
    const r = ritualControls({
      phase: "interviewing",
      hasProject: true,
      hasEntry: true,
      approved: false,
      streaming: false,
    });
    assert.equal(r.interviewing, true);
    assert.equal(r.proposing, false);
    assert.equal(r.canApprove, false);
    assert.equal(r.canComment, false);
    assert.equal(r.canNotThis, false);
    assert.equal(r.canSweep, false);
    assert.equal(r.approveLabel, UI_COPY.approveLabel);
  });

  it("makes approving the proposal the only action while proposing", () => {
    const r = ritualControls({
      phase: "proposing",
      hasProject: true,
      hasEntry: true,
      approved: true,
      streaming: false,
      isProposal: true,
    });
    assert.equal(r.proposing, true);
    assert.equal(r.canApprove, true);
    assert.equal(r.canComment, false);
    assert.equal(r.canNotThis, false);
    assert.equal(r.canSweep, false);
    // "Found Desk" is retired: the control reads Approve in every phase.
    assert.equal(r.approveLabel, UI_COPY.approveLabel);
    assert.equal(r.approveHint, UI_COPY.approveHintFounding);
  });

  it("locks all actions while streaming and restores ordinary sitting", () => {
    const busy = ritualControls({
      phase: "founded",
      hasProject: true,
      hasEntry: true,
      approved: false,
      streaming: true,
    });
    assert.equal(busy.canApprove, false);
    assert.equal(busy.canComment, false);
    assert.equal(busy.canSweep, false);

    const ready = ritualControls({
      phase: "founded",
      hasProject: true,
      hasEntry: true,
      approved: false,
      streaming: false,
    });
    assert.equal(ready.canApprove, true);
    assert.equal(ready.canComment, true);
    assert.equal(ready.canNotThis, true);
    assert.equal(ready.canSweep, true);
    assert.equal(busy.canNotThis, false);
  });
});

describe("ritual words come from core's catalog", () => {
  const base = {
    phase: "founded" as const,
    hasProject: true,
    hasEntry: true,
    approved: false,
    streaming: false,
  };

  it("labels every control from the catalog, in every phase", () => {
    for (const phase of ["none", "interviewing", "proposing", "founded"] as const) {
      const r = ritualControls({ ...base, phase });
      assert.equal(r.approveLabel, UI_COPY.approveLabel);
      assert.equal(r.commentLabel, UI_COPY.commentLabel);
      assert.equal(r.sweepLabel, UI_COPY.sweepLabel);
      assert.equal(r.sweepHint, UI_COPY.sweepHint);
      assert.equal(r.sweepUndoLabel, UI_COPY.sweepUndoLabel);
    }
  });

  it("reads Not this on a waiting file and Bring back on a set-aside one", () => {
    const waiting = ritualControls(base);
    assert.equal(waiting.notThisUndo, false);
    assert.equal(waiting.notThisLabel, UI_COPY.notThisLabel);
    assert.equal(waiting.notThisHint, UI_COPY.notThisHint);
    const aside = ritualControls({ ...base, setAside: true });
    assert.equal(aside.notThisUndo, true);
    assert.equal(aside.notThisLabel, UI_COPY.notThisUndoLabel);
    assert.equal(aside.notThisHint, UI_COPY.notThisUndoHint);
    assert.equal(aside.canNotThis, true);
  });

  it("refuses Not this on the proposal, as core does", () => {
    assert.equal(ritualControls({ ...base, isProposal: true }).canNotThis, false);
  });

  it("never puts a retired or house word on a control", () => {
    for (const phase of ["none", "interviewing", "proposing", "founded"] as const) {
      for (const setAside of [false, true]) {
        const r = ritualControls({ ...base, phase, setAside });
        const words = [
          r.approveLabel, r.approveHint, r.commentLabel, r.commentHint,
          r.notThisLabel, r.notThisHint, r.sweepLabel, r.sweepHint, r.sweepUndoLabel,
        ].join(" | ");
        assert.doesNotMatch(words, /Found Desk/);
        assert.doesNotMatch(words, /\bsweep\b/i);
        assert.doesNotMatch(words, /\b(desk|sitting|ruling|curator)\b/i);
      }
    }
  });
});

describe("status text from the catalog's states", () => {
  const on = { connected: true, hasProject: true, projectName: "Alpha", hasEntry: true };

  it("picks the state a running stream or broken desk is in first", () => {
    assert.equal(deskStateName({ ...on, phase: "founded", activity: "sweeping" }), "sweeping");
    assert.equal(deskStateName({ ...on, phase: "proposing", activity: "founding" }), "founding");
    assert.equal(deskStateName({ ...on, phase: "founded", activity: "broken" }), "broken");
    assert.equal(deskStateName({ ...on, phase: "interviewing", activity: "idle" }), "interviewing");
    assert.equal(deskStateName({ ...on, phase: "proposing", activity: "idle" }), "proposing");
    assert.equal(
      deskStateName({ ...on, hasEntry: false, phase: "founded", activity: "idle" }),
      "attached",
    );
    assert.equal(deskStateName({ ...on, phase: "founded", activity: "idle" }), undefined);
    assert.equal(
      deskStateName({ ...on, connected: false, phase: "founded", activity: "sweeping" }),
      undefined,
    );
  });

  it("renders a state in its line register, else the project name", () => {
    assert.equal(
      deskStatusLine({ ...on, phase: "founded", activity: "sweeping" }),
      UI_STATES.sweeping.line,
    );
    assert.equal(
      deskStatusLine({ ...on, phase: "proposing", activity: "idle" }),
      UI_STATES.proposing.line,
    );
    assert.equal(
      deskStatusLine({ ...on, phase: "founded", activity: "broken" }),
      UI_STATES.broken.line,
    );
    assert.equal(deskStatusLine({ ...on, phase: "founded", activity: "idle" }), "Alpha");
    assert.equal(
      deskStatusLine({ ...on, connected: false, phase: "founded", activity: "idle" }),
      OFFLINE_LINE,
    );
    assert.equal(
      deskStatusLine({ ...on, hasProject: false, phase: "none", activity: "idle" }),
      NO_PROJECT_LINE,
    );
  });
});

describe("founding phase from the core beacon", () => {
  it("trusts core's founded predicate, not entry counts", () => {
    // The bug this replaces: a found run that filed entries but never wrote
    // PROJECT.md opened in VS Code as an ordinary desk. Core's rule is charter
    // AND content entry (kettle-core docs/SITTING-FLOWS.md §3).
    assert.equal(
      foundingPhaseFrom({ status: "proposing", founded: false, has_proposal: true }),
      "proposing",
    );
    assert.equal(foundingPhaseFrom({ status: "founded", founded: true }), "founded");
    assert.equal(
      foundingPhaseFrom({ status: "interviewing", founded: false }),
      "interviewing",
    );
    assert.equal(
      foundingPhaseFrom({ status: "none", founded: false, has_proposal: true }),
      "proposing",
    );
    assert.equal(foundingPhaseFrom({ status: "none", founded: false }), "none");
  });

  it("falls back to status on a core too old to send founded", () => {
    assert.equal(foundingPhaseFrom({ status: "founded" }), "founded");
    assert.equal(foundingPhaseFrom({ status: "interviewing" }), "interviewing");
    assert.equal(foundingPhaseFrom({ status: "proposing" }), "proposing");
  });
});
