import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ritualDampenForZoomLevel } from "../ritualZoom";

describe("ritualDampenForZoomLevel", () => {
  it("is 1 at default zoom", () => {
    assert.equal(ritualDampenForZoomLevel(0), 1);
  });

  it("shrinks under positive zoom (partial counter-scale)", () => {
    const d1 = ritualDampenForZoomLevel(1);
    const d2 = ritualDampenForZoomLevel(2);
    const d3 = ritualDampenForZoomLevel(3);
    assert.ok(d1 < 1, `zoom+1 dampen should be <1, got ${d1}`);
    assert.ok(d2 < d1, `zoom+2 should dampen more than +1 (${d2} < ${d1})`);
    assert.ok(d3 < d2, `zoom+3 should dampen more than +2 (${d3} < ${d2})`);
    // Partial: not full 1/1.2^z (that would be ~0.69 at z=2)
    const fullCounter2 = 1 / Math.pow(1.2, 2);
    assert.ok(
      d2 > fullCounter2,
      `partial dampen (${d2}) should leave more size than full counter (${fullCounter2})`,
    );
  });

  it("grows slightly under negative zoom but stays capped", () => {
    const d = ritualDampenForZoomLevel(-2);
    assert.ok(d > 1, `negative zoom should slightly enlarge ritual bar, got ${d}`);
    assert.ok(d <= 1.15, `should not exceed 1.15 cap, got ${d}`);
  });

  it("clamps extreme zoom into a sane band", () => {
    assert.ok(ritualDampenForZoomLevel(10) >= 0.72);
    assert.ok(ritualDampenForZoomLevel(-10) <= 1.15);
  });

  it("treats non-finite as 0", () => {
    assert.equal(ritualDampenForZoomLevel(Number.NaN), 1);
    assert.equal(ritualDampenForZoomLevel(Number.POSITIVE_INFINITY), 1);
  });
});
