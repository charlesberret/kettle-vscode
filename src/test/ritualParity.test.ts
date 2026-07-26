import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatModeForPhase,
  isProposalEntry,
  proposalDocumentPath,
  proposalEntryForFounding,
  ritualControls,
  shouldPostCompact,
} from "../ritualParity";

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
    assert.deepEqual(
      ritualControls({
        phase: "interviewing",
        hasProject: true,
        hasEntry: true,
        approved: false,
        streaming: false,
      }),
      {
        interviewing: true,
        proposing: false,
        canApprove: false,
        canComment: false,
        canSweep: false,
        approveLabel: "Approve",
      },
    );
  });

  it("makes proposal approve the sole Found desk action", () => {
    assert.deepEqual(
      ritualControls({
        phase: "proposing",
        hasProject: true,
        hasEntry: true,
        approved: true,
        streaming: false,
      }),
      {
        interviewing: false,
        proposing: true,
        canApprove: true,
        canComment: false,
        canSweep: false,
        approveLabel: "Found Desk",
      },
    );
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
    assert.equal(ready.canSweep, true);
  });
});
