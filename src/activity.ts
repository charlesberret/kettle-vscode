import type { StreamEvent } from "./api";

/**
 * Activity is operational chrome, not a reasoning transcript. Thought events
 * deliberately collapse to a coarse label even if an older core leaks text.
 */
export function activityLabelForEvent(event: StreamEvent): string | undefined {
  if (event.t !== "activity") return undefined;
  if (String(event.kind || "") === "thought") return "thinking…";
  return String(event.s || "").trim() || "working…";
}
