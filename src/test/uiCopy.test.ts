import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UI_COPY, type UiCopyKey } from "../uiCopy";

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

  it("includes the Desk-wired founding / proposing / comment keys", () => {
    for (const key of DESK_WIRED_KEYS) {
      assert.ok(key in UI_COPY, `missing ${key}`);
      assert.equal(typeof UI_COPY[key], "string");
    }
    assert.match(UI_COPY.foundingQueueHintTitle, /Founding/i);
    assert.match(UI_COPY.proposingQueueHintTitle, /Proposal/i);
    assert.match(UI_COPY.commentPlaceholder, /Enter saves/);
  });
});
