import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UI_COPY,
  UI_COPY_SHORT,
  UI_STATES,
  pickStateRegister,
  uiCopy,
  uiState,
  type UiCopyKey,
  type UiStateName,
} from "../uiCopy";

/** Keys the Desk panel must wire from the core snapshot (not hardcode). */
const DESK_WIRED_KEYS: UiCopyKey[] = [
  "chatPlaceholder",
  "chatPlaceholderFounding",
  "chatPlaceholderProposing",
  "editorPlaceholderFounding",
  "editorPlaceholderProposing",
  "commentPlaceholder",
  "foundingQueueHintTitle",
  "foundingQueueHintBody",
  "proposingQueueHintTitle",
  "proposingQueueHintBody",
  "noEntryBriefBody",
  // The four ritual controls and the Finish batch drawer.
  "approveLabel",
  "approveHint",
  "approveHintFounding",
  "commentLabel",
  "commentHint",
  "commentSaveLabel",
  "notThisLabel",
  "notThisHint",
  "notThisUndoLabel",
  "notThisUndoHint",
  "sweepLabel",
  "sweepHint",
  "sweepUndoLabel",
  "sweepConfirmTitle",
  "sweepConfirmBody",
  "sweepThrustPlaceholder",
];

/** States a viewport renders (kettle-core docs/SITTING-FLOWS.md §7). */
const STATES: UiStateName[] = [
  "attached",
  "interviewing",
  "proposing",
  "founding",
  "founded",
  "sweeping",
  "broken",
];

describe("Desk ui-copy snapshot", () => {
  it("keeps non-empty strings for every key", () => {
    for (const [key, value] of Object.entries(UI_COPY)) {
      if (key === "editorPlaceholder") {
        assert.equal(typeof value, "string");
        continue;
      }
      assert.equal(typeof value, "string");
      assert.ok(String(value).trim().length > 0, `${key} should be non-empty`);
    }
  });

  it("includes every key the Desk panel wires", () => {
    for (const key of DESK_WIRED_KEYS) {
      assert.ok(key in UI_COPY, `missing ${key}`);
      assert.equal(typeof UI_COPY[key], "string");
    }
    assert.match(UI_COPY.commentPlaceholder, /Enter saves/);
  });

  it("carries core's current ritual words", () => {
    assert.equal(UI_COPY.approveLabel, "Approve");
    // Retired 2026-10-01: Approve reads Approve while proposing too.
    assert.equal(UI_COPY.approveLabelFounding, "Approve");
    assert.equal(UI_COPY.notThisLabel, "Not this");
    assert.equal(UI_COPY.notThisUndoLabel, "Bring back");
    assert.equal(UI_COPY.sweepLabel, "Finish batch");
    assert.equal(UI_COPY_SHORT.sweepLabel, "Finish");
    assert.equal(UI_COPY.sweepUndoLabel, "Undo");
  });

  it("puts no retired or house word in any on-screen string", () => {
    const onScreen = [
      ...Object.values(UI_COPY),
      ...Object.values(UI_COPY_SHORT),
      ...Object.values(UI_STATES).flatMap((s) => Object.values(s)),
    ].join("\n");
    assert.doesNotMatch(onScreen, /Found Desk/);
    assert.doesNotMatch(onScreen, /\bsweep\b/i);
    assert.doesNotMatch(onScreen, /\b(desk|sitting|ruling|charter|curator)\b/i);
  });

  it("prefers the short variant only when asked, and falls back to text", () => {
    assert.equal(uiCopy("sweepLabel"), "Finish batch");
    assert.equal(uiCopy("sweepLabel", { short: true }), "Finish");
    assert.equal(uiCopy("notThisLabel", { short: true }), UI_COPY.notThisLabel);
  });
});

describe("Desk ui-copy states", () => {
  it("carries every flow state, each with at least one register", () => {
    for (const name of STATES) {
      assert.ok(name in UI_STATES, `missing state ${name}`);
      const rec = UI_STATES[name] as Record<string, string>;
      assert.ok(rec.line || rec.short || rec.full, `${name} has no register`);
    }
  });

  it("renders the register asked for", () => {
    assert.equal(uiState("sweeping", "line"), UI_STATES.sweeping.line);
    assert.equal(uiState("proposing", "short"), UI_STATES.proposing.short);
    assert.equal(uiState("broken", "full"), UI_STATES.broken.full);
    assert.equal(uiState("founded"), UI_STATES.founded.short);
  });

  it("falls back to the longest register present when one is missing", () => {
    assert.equal(pickStateRegister({ full: "F", line: "L" }, "short"), "F");
    assert.equal(pickStateRegister({ line: "L" }, "full"), "L");
    assert.equal(pickStateRegister({ short: "S", line: "L" }, "line"), "L");
    assert.equal(pickStateRegister({}, "line"), "");
  });
});
