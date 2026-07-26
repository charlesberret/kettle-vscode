/**
 * Partial counter-scale for Desk ritual buttons under window.zoomLevel.
 * Full counter would be 1/1.2^z (VS Code ~20% per step). We only cancel
 * part of that so chrome stays readable but does not balloon on small screens.
 *
 * Pure module (no vscode import) so node tests can exercise the curve.
 */
export function ritualDampenForZoomLevel(zoomLevel: number): number {
  const z = Number.isFinite(zoomLevel) ? zoomLevel : 0;
  const step = Math.pow(1.2, z);
  const k = 0.55; // cancel ~55% of zoom growth on the ritual bar
  const d = 1 / Math.pow(step, k);
  // Keep within a sane band so extreme zoom does not invert usability
  return Math.min(1.15, Math.max(0.72, d));
}
