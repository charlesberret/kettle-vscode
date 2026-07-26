import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PROJECT_MENU_CSS_GUARDS,
  fixedMenuStyle,
  shouldCloseFloatingMenu,
} from "../projectMenu";

describe("project dropdown geometry", () => {
  it("places the menu under the anchor with a usable min width", () => {
    const style = fixedMenuStyle(
      { top: 10, left: 12, bottom: 40, right: 120, width: 100, height: 30 },
      { width: 400, height: 600 },
    );
    assert.equal(style.position, "fixed");
    assert.equal(style.zIndex, "10000");
    assert.equal(style.top, "46px"); // 40 + 6 gap
    assert.equal(style.left, "12px");
    assert.equal(style.width, "280px"); // min width wins over short pill
  });

  it("keeps the menu inside the viewport when the pill is near the right edge", () => {
    const style = fixedMenuStyle(
      { top: 10, left: 300, bottom: 40, right: 390, width: 90, height: 30 },
      { width: 400, height: 600 },
    );
    const left = Number(style.left.replace("px", ""));
    const width = Number(style.width.replace("px", ""));
    assert.ok(left + width <= 392, `menu overflows: left=${left} width=${width}`);
    assert.ok(left >= 8);
  });
});

describe("project dropdown outside-close", () => {
  it("does not close when closed", () => {
    assert.equal(
      shouldCloseFloatingMenu({
        menuOpen: false,
        targetInWrap: false,
        targetInMenu: false,
      }),
      false,
    );
  });

  it("does not close for clicks in the wrap or menu", () => {
    assert.equal(
      shouldCloseFloatingMenu({
        menuOpen: true,
        targetInWrap: true,
        targetInMenu: false,
      }),
      false,
    );
    assert.equal(
      shouldCloseFloatingMenu({
        menuOpen: true,
        targetInWrap: false,
        targetInMenu: true,
      }),
      false,
    );
  });

  it("closes for true outside clicks when open", () => {
    assert.equal(
      shouldCloseFloatingMenu({
        menuOpen: true,
        targetInWrap: false,
        targetInMenu: false,
      }),
      true,
    );
  });
});

describe("deskPanel dropdown structure guards", () => {
  it("keeps clickable-menu CSS and markup in the Desk template source", () => {
    // Tests run from dist/test — source lives next to package root src/.
    const srcPath = path.join(__dirname, "..", "..", "src", "deskPanel.ts");
    const src = fs.readFileSync(srcPath, "utf8");
    for (const guard of PROJECT_MENU_CSS_GUARDS) {
      assert.ok(src.includes(guard), `missing Desk guard: ${guard}`);
    }
    // Fixed menus + open !important are load-bearing for VS Code webview clicks.
    assert.match(src, /\.proj-menu\.open\s*\{\s*display:\s*block\s*!important/);
    assert.match(src, /position:\s*fixed/);
    assert.match(src, /placeFixedMenu/);
    assert.match(src, /zIndex = "10000"/);
    // Must not reintroduce a permanent capture-phase closer that races open.
    assert.doesNotMatch(
      src,
      /document\.addEventListener\("mousedown", function\(e\) \{\s*const pwrap/,
    );
  });

  it("does not embed host-template-breaking regex escapes in the webview script", () => {
    const srcPath = path.join(__dirname, "..", "..", "src", "deskPanel.ts");
    const src = fs.readFileSync(srcPath, "utf8");
    const shell = src.slice(src.indexOf("function shellHtml"), src.indexOf("function icon("));
    // \b and \s inside /regex/ in a host template string corrupt the webview parse.
    assert.doesNotMatch(shell, /\/\\?\^\\\/compact\\b/);
    assert.doesNotMatch(shell, /\/\^\\\/compact\\b/);
    assert.doesNotMatch(shell, /\/\\s\*/); // bare \s in /.../ regex literal
    assert.match(shell, /indexOf\("\/compact/);
  });
});
