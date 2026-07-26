import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activityLabelForEvent } from "../activity";

describe("activity labels", () => {
  it("never displays provider thought text", () => {
    const label = activityLabelForEvent({
      t: "activity",
      kind: "thought",
      s: "raw private reasoning that must not be shown",
    });
    assert.equal(label, "thinking…");
    assert.doesNotMatch(label || "", /private reasoning/);
  });

  it("keeps non-thought operational labels", () => {
    assert.equal(
      activityLabelForEvent({ t: "activity", kind: "status", s: "indexing files" }),
      "indexing files",
    );
    assert.equal(activityLabelForEvent({ t: "activity", kind: "status" }), "working…");
    assert.equal(activityLabelForEvent({ t: "text", s: "not activity" }), undefined);
  });
});
