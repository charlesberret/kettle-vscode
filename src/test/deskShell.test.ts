import assert from "node:assert/strict";
import * as fs from "node:fs";
import Module from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";
import { UI_COPY, UI_STATES } from "../uiCopy";

/**
 * The Desk panel imports `vscode`, which only exists inside the editor. Its HTML
 * shell is a pure function of the catalog, so load it with an empty stand-in.
 */
function loadShellHtml(): () => string {
  const mod = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = mod._load;
  mod._load = function (request, parent, isMain) {
    if (request === "vscode") return {};
    return original.call(this, request, parent, isMain);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("../deskPanel") as { shellHtml: () => string }).shellHtml;
  } finally {
    mod._load = original;
  }
}

const html = loadShellHtml()();
const script = html.slice(html.lastIndexOf("<script"), html.lastIndexOf("</script>"));
const scriptBody = script.slice(script.indexOf(">") + 1);

/** Text a user can see: the markup with script, style and tags removed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ");
}

/** Attribute values a user can see: titles, placeholders, aria labels. */
function visibleAttributes(markup: string): string {
  const out: string[] = [];
  const re = /\b(title|placeholder|aria-label)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup.replace(/<script[\s\S]*?<\/script>/g, "")))) out.push(m[2]);
  return out.join("\n");
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

describe("Desk panel shell", () => {
  it("ships a webview script that parses", () => {
    assert.ok(scriptBody.length > 1000, "script not found in shell");
    // Throws SyntaxError if the template-string escaping broke the client JS.
    assert.doesNotThrow(() => new Function(scriptBody));
  });

  it("orders the ritual Approve · Comment · Not this · Finish batch", () => {
    const ids = ["btnApprove", "btnCommentToggle", "btnNotThis", "btnSweep"].map((id) =>
      html.indexOf(`id="${id}"`),
    );
    assert.ok(ids.every((i) => i > 0), `missing a ritual control: ${ids}`);
    assert.deepEqual([...ids].sort((a, b) => a - b), ids);
  });

  it("labels the controls with the catalog's words", () => {
    const text = decode(visibleText(html));
    for (const key of ["approveLabel", "commentLabel", "notThisLabel", "sweepLabel"] as const) {
      assert.ok(text.includes(UI_COPY[key]), `missing ${key}: ${UI_COPY[key]}`);
    }
    const attrs = decode(visibleAttributes(html));
    for (const key of ["approveHint", "commentHint", "notThisHint", "sweepHint"] as const) {
      assert.ok(attrs.includes(UI_COPY[key]), `missing ${key} tooltip`);
    }
    assert.ok(attrs.includes(UI_COPY.sweepThrustPlaceholder));
    assert.ok(text.includes(UI_STATES.attached.line), "empty path line is the attached state");
  });

  it("carries the Undo and Bring back words into the client", () => {
    assert.ok(scriptBody.includes(JSON.stringify(UI_COPY.sweepUndoLabel)));
    assert.ok(scriptBody.includes('post("notThis")'));
  });

  it("puts neither Sweep nor Found Desk on screen", () => {
    const seen = decode(`${visibleText(html)}\n${visibleAttributes(html)}`);
    assert.doesNotMatch(seen, /Found Desk/);
    assert.doesNotMatch(seen, /\bsweep\b/i);
    assert.doesNotMatch(seen, /\b(desk|sitting|ruling|curator)\b/i);
    // Client-side literals that reach the DOM.
    assert.doesNotMatch(scriptBody, /"Found Desk"/);
    assert.doesNotMatch(scriptBody, /textContent\s*=\s*"[^"]*\bSweep\b/);
  });
});

describe("package.json contributes plain words", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  ) as {
    contributes: {
      commands: { command: string; title: string; category?: string }[];
      menus: Record<string, { command: string; when?: string }[]>;
    };
  };
  const commands = pkg.contributes.commands;
  const title = (id: string) => commands.find((c) => c.command === id)?.title;

  it("keeps command ids and names the controls from the catalog", () => {
    assert.equal(title("kettle.notThis"), UI_COPY.notThisLabel);
    assert.equal(title("kettle.bringBack"), UI_COPY.notThisUndoLabel);
    assert.match(String(title("kettle.sweep")), /^Finish Batch$/);
    for (const id of ["kettle.approve", "kettle.comment", "kettle.sweep", "kettle.refreshBriefs"]) {
      assert.ok(title(id), `command ${id} must stay contributed`);
    }
  });

  it("puts no house word in a command title", () => {
    const titles = commands.map((c) => c.title).join("\n");
    assert.doesNotMatch(titles, /Found Desk/);
    assert.doesNotMatch(titles, /\b(sweep|desk|sitting|ruling|curator|founding|briefs?|entry)\b/i);
  });

  it("does not prefix a categorized title with the category again", () => {
    for (const c of commands) {
      if (c.category) assert.ok(!c.title.startsWith(`${c.category}:`), c.command);
    }
  });

  it("offers Not this on waiting rows and Bring back on set-aside rows", () => {
    const ctx = pkg.contributes.menus["view/item/context"];
    const notThis = ctx.find((m) => m.command === "kettle.notThis");
    const bringBack = ctx.find((m) => m.command === "kettle.bringBack");
    assert.match(String(notThis?.when), /viewItem == kettle\.entry\b/);
    assert.doesNotMatch(String(notThis?.when), /setAside|approved/);
    assert.match(String(bringBack?.when), /viewItem == kettle\.entry\.setAside/);
  });
});
