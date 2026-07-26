/**
 * Project/model dropdown geometry and open/close rules.
 * Kept pure so CI can fail if stacking or outside-close races regress.
 */

export type Rect = {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
};

export type FixedMenuStyle = {
  position: "fixed";
  left: string;
  top: string;
  width: string;
  maxWidth: string;
  zIndex: string;
};

/** Fixed placement under the anchor — survives body overflow and sibling stacking. */
export function fixedMenuStyle(
  anchor: Rect,
  viewport: { width: number; height: number },
  opts?: { minWidth?: number; gap?: number },
): FixedMenuStyle {
  const gap = opts?.gap ?? 6;
  const minWidth = opts?.minWidth ?? 280;
  const maxW = Math.max(160, viewport.width - 16);
  const width = Math.min(Math.max(anchor.width, minWidth), maxW);
  let left = anchor.left;
  if (left + width > viewport.width - 8) {
    left = Math.max(8, viewport.width - 8 - width);
  }
  if (left < 8) left = 8;
  let top = anchor.bottom + gap;
  // If near the bottom of the webview, still open downward — stream scrolls; header is top.
  if (top > viewport.height - 40) {
    top = Math.max(8, anchor.top - gap); // prefer flip only when absurdly tight
  }
  return {
    position: "fixed",
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${Math.round(width)}px`,
    maxWidth: `${Math.round(maxW)}px`,
    zIndex: "10000",
  };
}

/**
 * Outside-close rule for project/model menus.
 * Target inside the wrap OR the menu must not close (menu may be fixed under body).
 */
export function shouldCloseFloatingMenu(input: {
  menuOpen: boolean;
  targetInWrap: boolean;
  targetInMenu: boolean;
}): boolean {
  if (!input.menuOpen) return false;
  if (input.targetInWrap || input.targetInMenu) return false;
  return true;
}

/** CSS substrings the Desk webview must keep so the dropdown stays clickable. */
export const PROJECT_MENU_CSS_GUARDS = [
  "header.top",
  "z-index: 100",
  ".proj-menu",
  ".proj-menu.open",
  "id=\"btnProject\"",
  "id=\"projMenu\"",
] as const;
