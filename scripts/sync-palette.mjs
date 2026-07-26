#!/usr/bin/env node
/**
 * Project kettle-core/static/kettle-palette.json into VS Code color themes.
 *
 * Explicit maintainer action. Ordinary package/test use the committed theme
 * JSON under themes/. Run with a sibling core checkout (or KETTLE_SRC).
 *
 *   npm run sync-palette          # rewrite themes/kettle-*-color-theme.json
 *   npm run check-palette         # exit 1 if committed themes drift
 *
 * Resolution order for the palette file:
 *   1. KETTLE_PALETTE (absolute path)
 *   2. KETTLE_SRC / SETSWEEP_SRC + /static/kettle-palette.json
 *   3. Sibling ../kettle-core or ../../kettle-core (and legacy setsweep-core)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");

const OUT = {
  dark: path.join(pkgRoot, "themes", "kettle-dark-color-theme.json"),
  light: path.join(pkgRoot, "themes", "kettle-light-color-theme.json"),
};

function candidates() {
  const list = [];
  if (process.env.KETTLE_PALETTE) list.push(process.env.KETTLE_PALETTE);
  for (const env of ["KETTLE_SRC", "SETSWEEP_SRC"]) {
    if (process.env[env]) {
      list.push(path.join(process.env[env], "static", "kettle-palette.json"));
    }
  }
  list.push(
    path.resolve(pkgRoot, "../kettle-core/static/kettle-palette.json"),
    path.resolve(pkgRoot, "../setsweep-core/static/kettle-palette.json"),
    path.resolve(pkgRoot, "../../kettle-core/static/kettle-palette.json"),
    path.resolve(pkgRoot, "../../setsweep-core/static/kettle-palette.json"),
  );
  return list;
}

function findPalette() {
  for (const p of candidates()) {
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  return null;
}

function parseHex(hex) {
  const h = String(hex).replace("#", "").trim();
  if (h.length !== 6) throw new Error(`bad hex: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** t=0 → a, t=1 → b */
function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  return toHex({
    r: A.r + (B.r - A.r) * t,
    g: A.g + (B.g - A.g) * t,
    b: A.b + (B.b - A.b) * t,
  });
}

function alpha(hex, aa) {
  return `${hex}${aa}`;
}

function resolveMode(palette, mode) {
  const block = palette[mode];
  if (!block?.ansi || block.ansi.length !== 16) {
    throw new Error(`palette.${mode}.ansi must have 16 colors`);
  }
  const ansi = block.ansi.map((h) => h.toLowerCase());
  const role = (map, key) => {
    const idx = map[key];
    if (typeof idx !== "number" || idx < 0 || idx > 15) {
      throw new Error(`palette.${mode}: bad role index for ${key}`);
    }
    return ansi[idx];
  };
  const iface = block.iface || {};
  const slots = block.slots || {};
  return {
    ansi,
    bg: role(iface, "bg"),
    fg: role(iface, "fg"),
    muted: role(iface, "muted"),
    panel: role(iface, "panel"),
    panel2: role(iface, "panel2"),
    line: role(iface, "line"),
    acc: role(iface, "acc"),
    link: role(iface, "link"),
    activebg: role(iface, "activebg"),
    selection: role(iface, "selection"),
    good: role(iface, "good"),
    warn: role(iface, "warn"),
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15],
    mdhead: role(slots, "mdhead"),
    comment: role(slots, "comment"),
  };
}

function buildChrome(c, isDark) {
  const black = "#000000";
  const white = "#ffffff";
  if (isDark) {
    return {
      chrome: mix(c.bg, black, 0.28),
      chromeDeep: mix(c.bg, black, 0.42),
      surface: mix(c.bg, c.fg, 0.04),
      surface2: mix(c.bg, c.fg, 0.07),
      hover: mix(c.bg, c.fg, 0.06),
      selectSoft: mix(c.bg, c.line, 0.55),
      mutedText: mix(c.fg, c.bg, 0.42),
      dimText: mix(c.fg, c.bg, 0.55),
      punct: mix(c.fg, c.bg, 0.62),
      lineHover: mix(c.line, c.fg, 0.15),
    };
  }
  return {
    chrome: mix(c.bg, c.line, 0.35),
    chromeDeep: mix(c.bg, c.line, 0.55),
    surface: mix(c.panel, c.line, 0.12),
    surface2: mix(c.panel, c.line, 0.2),
    hover: mix(c.bg, c.line, 0.25),
    selectSoft: mix(c.line, c.fg, 0.12),
    mutedText: mix(c.fg, c.bg, 0.45),
    dimText: mix(c.fg, c.bg, 0.55),
    punct: mix(c.fg, c.bg, 0.5),
    lineHover: mix(c.line, c.fg, 0.1),
  };
}

function tokenColors(c, ch) {
  const rules = [
    ["Comments", ["comment", "punctuation.definition.comment", "string.comment"], { foreground: ch.dimText, fontStyle: "italic" }],
    ["Strings", ["string", "string.quoted", "string.template"], { foreground: c.brightGreen }],
    ["String escapes", ["constant.character.escape", "string.escape", "constant.character.escape.backslash"], { foreground: c.brightCyan }],
    ["Numbers", ["constant.numeric", "constant.numeric.integer", "constant.numeric.float", "constant.numeric.hex"], { foreground: c.brightYellow }],
    ["Language constants", ["constant.language", "constant.language.boolean", "constant.language.null", "constant.language.undefined"], { foreground: c.magenta, fontStyle: "italic" }],
    ["Keywords", ["keyword", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "keyword.other"], { foreground: c.brightMagenta }],
    ["Storage", ["storage", "storage.type", "storage.modifier", "storage.type.function", "storage.type.class"], { foreground: c.magenta }],
    ["Operators", ["keyword.operator", "keyword.operator.assignment", "keyword.operator.arithmetic", "keyword.operator.comparison", "keyword.operator.logical"], { foreground: ch.mutedText }],
    ["Functions", ["entity.name.function", "support.function", "meta.function-call", "meta.function-call entity.name.function", "variable.function"], { foreground: c.brightBlue }],
    ["Types & classes", ["entity.name.type", "entity.name.class", "support.class", "support.type", "entity.other.inherited-class"], { foreground: c.acc }],
    ["Namespaces / modules", ["entity.name.namespace", "entity.name.module", "support.module"], { foreground: c.blue }],
    ["Variables", ["variable", "variable.other", "variable.language", "meta.definition.variable"], { foreground: c.fg }],
    ["Parameters", ["variable.parameter", "meta.function.parameters", "meta.parameters"], { foreground: c.brightRed }],
    ["Properties", ["variable.other.property", "variable.other.object.property", "support.type.property-name", "meta.object-literal.key"], { foreground: c.brightBlue }],
    ["Tags (HTML/XML)", ["entity.name.tag", "punctuation.definition.tag"], { foreground: c.brightRed }],
    ["Attributes", ["entity.other.attribute-name", "entity.other.attribute-name.html", "entity.other.attribute-name.xml"], { foreground: c.brightYellow }],
    ["Punctuation", ["punctuation", "meta.brace", "punctuation.definition.block", "punctuation.section"], { foreground: ch.punct }],
    ["Regex", ["string.regexp", "constant.regexp", "source.regexp"], { foreground: c.brightCyan }],
    ["Decorators / annotations", ["meta.decorator", "meta.annotation", "punctuation.decorator", "entity.name.function.decorator", "support.function.magic"], { foreground: c.brightCyan }],
    ["Invalid", ["invalid", "invalid.illegal", "invalid.deprecated"], { foreground: c.brightRed, fontStyle: "italic underline" }],
    ["MD headings", ["markup.heading", "entity.name.section.markdown", "punctuation.definition.heading.markdown"], { foreground: c.mdhead, fontStyle: "bold" }],
    ["MD bold", ["markup.bold", "punctuation.definition.bold.markdown"], { foreground: c.brightWhite, fontStyle: "bold" }],
    ["MD italic", ["markup.italic", "punctuation.definition.italic.markdown"], { foreground: mix(c.fg, c.link, 0.25), fontStyle: "italic" }],
    ["MD strikethrough", ["markup.strikethrough"], { foreground: ch.dimText, fontStyle: "strikethrough" }],
    ["MD inline code", ["markup.inline.raw", "markup.raw.inline", "string.other.link.title.markdown"], { foreground: c.brightCyan }],
    ["MD fenced code", ["markup.fenced_code", "markup.raw", "markup.fenced_code.block.markdown"], { foreground: c.brightCyan }],
    ["MD links", ["markup.underline.link", "string.other.link", "meta.link.inline.markdown", "markup.underline.link.markdown"], { foreground: c.brightBlue, fontStyle: "underline" }],
    ["MD link titles", ["string.other.link.description.title.markdown", "string.other.link.description.markdown"], { foreground: c.brightGreen }],
    ["MD quotes", ["markup.quote", "punctuation.definition.quote.begin.markdown"], { foreground: ch.mutedText, fontStyle: "italic" }],
    ["MD lists", ["punctuation.definition.list.begin.markdown", "markup.list"], { foreground: c.brightYellow }],
    ["MD hr", ["meta.separator.markdown"], { foreground: ch.dimText }],
    ["JSON property names", ["support.type.property-name.json", "support.type.property-name.json.comments", "source.json meta.structure.dictionary.json support.type.property-name", "source.json.comments support.type.property-name"], { foreground: c.brightBlue }],
    ["JSON strings (values)", ["source.json string.quoted", "source.json.comments string.quoted", "meta.structure.dictionary.value.json string"], { foreground: c.brightGreen }],
    ["JSON constants", ["source.json constant.language", "source.json.comments constant.language"], { foreground: c.magenta, fontStyle: "italic" }],
    ["JSON numbers", ["source.json constant.numeric", "source.json.comments constant.numeric"], { foreground: c.brightYellow }],
    ["JSON punctuation", ["source.json punctuation.separator", "source.json punctuation.definition.dictionary", "source.json punctuation.definition.array", "source.json.comments punctuation"], { foreground: ch.punct }],
    ["JSONC comments", ["source.json.comments comment", "comment.line.double-slash.js"], { foreground: ch.dimText, fontStyle: "italic" }],
    ["YAML keys", ["entity.name.tag.yaml", "source.yaml entity.name.tag", "source.yaml support.type.property-name", "source.yaml meta.structure.dictionary.yaml support.type.property-name.yaml"], { foreground: c.brightBlue, fontStyle: "bold" }],
    ["YAML key-value separators", ["punctuation.separator.key-value.mapping.yaml", "punctuation.separator.key-value.yaml", "source.yaml punctuation.separator.mapping"], { foreground: ch.punct }],
    ["YAML sequence markers", ["punctuation.definition.block.sequence.item.yaml", "punctuation.definition.sequence.item.yaml", "source.yaml punctuation.definition.block.sequence.item"], { foreground: c.brightYellow }],
    ["YAML anchors & aliases", ["entity.name.type.anchor.yaml", "variable.other.alias.yaml", "punctuation.definition.anchor.yaml", "punctuation.definition.alias.yaml"], { foreground: c.magenta }],
    ["YAML tags / types", ["storage.type.tag-yaml", "support.type.tag-yaml", "entity.name.type.yaml"], { foreground: c.brightCyan }],
    ["YAML booleans & null", ["constant.language.boolean.yaml", "constant.language.null.yaml", "constant.other.bool.yaml", "source.yaml constant.language"], { foreground: c.magenta, fontStyle: "italic" }],
    ["YAML numbers", ["constant.numeric.integer.yaml", "constant.numeric.float.yaml", "constant.numeric.yaml", "source.yaml constant.numeric"], { foreground: c.brightYellow }],
    ["YAML quoted strings", ["string.quoted.single.yaml", "string.quoted.double.yaml", "source.yaml string.quoted"], { foreground: c.brightGreen }],
    ["YAML plain scalars", ["string.unquoted.plain.out.yaml", "string.unquoted.plain.in.yaml", "string.unquoted.plain.yaml", "source.yaml string.unquoted", "meta.structure.dictionary.value.yaml string", "meta.structure.dictionary.value.yaml string.unquoted"], { foreground: c.fg }],
    ["YAML block scalars", ["string.unquoted.block.yaml", "keyword.control.flow.block-scalar.literal.yaml", "keyword.control.flow.block-scalar.folded.yaml"], { foreground: ch.mutedText }],
    ["YAML comments", ["comment.line.number-sign.yaml", "source.yaml comment"], { foreground: ch.dimText, fontStyle: "italic" }],
    ["YAML document markers", ["entity.other.document.begin.yaml", "entity.other.document.end.yaml"], { foreground: c.acc, fontStyle: "bold" }],
    ["TOML tables / sections", ["entity.name.section.toml", "entity.name.section.ini", "punctuation.definition.table.toml", "entity.name.section.group-title.ini"], { foreground: c.acc, fontStyle: "bold" }],
    ["TOML/INI keys", ["support.type.property-name.toml", "entity.name.tag.ini", "source.toml support.type.property-name", "source.ini keyword.other.definition"], { foreground: c.brightBlue }],
    ["TOML/INI values", ["source.toml string", "source.ini string", "source.toml constant", "source.ini constant"], { foreground: c.brightGreen }],
    ["TOML datetimes", ["constant.other.date.toml", "constant.other.datetime.toml"], { foreground: c.brightCyan }],
    ["Python self/cls", ["variable.language.special.self.python", "variable.language.special.cls.python", "variable.parameter.function.language.special.self.python"], { foreground: c.magenta, fontStyle: "italic" }],
    ["Python builtins", ["support.function.builtin.python", "support.type.python", "support.constant.python"], { foreground: c.blue }],
    ["Python decorators", ["entity.name.function.decorator.python", "meta.function.decorator.python", "punctuation.definition.decorator.python"], { foreground: c.brightCyan }],
    ["Python f-string", ["string.interpolated.python", "meta.fstring.python", "constant.character.format.placeholder.other.python"], { foreground: c.brightCyan }],
    ["Python magic methods", ["support.function.magic.python", "support.variable.magic.python"], { foreground: c.brightCyan, fontStyle: "italic" }],
    ["Python format specs", ["meta.format.percent.python", "meta.format.brace.python"], { foreground: c.brightYellow }],
    ["JS/TS this/super", ["variable.language.this", "variable.language.super"], { foreground: c.magenta, fontStyle: "italic" }],
    ["JS/TS template expr", ["punctuation.definition.template-expression.begin", "punctuation.definition.template-expression.end", "meta.template.expression"], { foreground: c.brightCyan }],
    ["TS types", ["support.type.primitive.ts", "support.type.primitive.tsx", "entity.name.type.ts", "entity.name.type.tsx", "meta.type.annotation", "meta.type.parameters"], { foreground: c.acc }],
    ["JS/TS object keys", ["meta.object-literal.key", "meta.object-literal.key.js", "meta.object-literal.key.ts", "meta.object-literal.key.tsx"], { foreground: c.brightBlue }],
    ["JS/TS imports", ["keyword.control.import", "keyword.control.export", "keyword.control.from", "meta.import", "meta.export"], { foreground: c.brightMagenta }],
    ["JSX/TSX component tags", ["support.class.component", "entity.name.tag.jsx", "entity.name.tag.tsx", "support.class.component.js", "support.class.component.tsx"], { foreground: c.brightYellow }],
    ["HTML doctype", ["meta.tag.sgml.doctype", "meta.tag.metadata.doctype"], { foreground: ch.mutedText, fontStyle: "italic" }],
    ["HTML entities", ["constant.character.entity", "constant.character.entity.html"], { foreground: c.brightYellow }],
    ["XML namespaces", ["entity.other.attribute-name.namespace", "entity.name.tag.namespace"], { foreground: c.blue }],
    ["CSS selectors", ["entity.name.tag.css", "entity.other.attribute-name.class.css", "entity.other.attribute-name.id.css", "entity.other.attribute-name.pseudo-class.css", "entity.other.attribute-name.pseudo-element.css", "source.css entity.name.tag", "source.scss entity.name.tag"], { foreground: c.brightRed }],
    ["CSS properties", ["support.type.property-name.css", "support.type.property-name.scss", "support.type.property-name.less", "meta.property-name"], { foreground: c.brightBlue }],
    ["CSS values", ["meta.property-value", "meta.property-value.css", "support.constant.property-value.css"], { foreground: c.fg }],
    ["CSS functions", ["support.function.misc.css", "support.function.misc.scss", "support.function.transform.css"], { foreground: c.brightBlue }],
    ["CSS units / numbers", ["keyword.other.unit", "keyword.other.unit.css", "keyword.other.unit.scss", "constant.numeric.css"], { foreground: c.brightYellow }],
    ["CSS !important", ["keyword.other.important.css", "keyword.other.important.scss"], { foreground: c.brightRed, fontStyle: "bold" }],
    ["CSS variables", ["variable.css", "variable.scss", "variable.argument.css", "support.type.custom-property.css"], { foreground: c.brightCyan }],
    ["SCSS variables / mixins", ["variable.scss", "entity.name.function.scss", "keyword.control.at-rule", "keyword.control.at-rule.scss"], { foreground: c.brightMagenta }],
    ["Shell shebang", ["comment.line.number-sign.shebang", "comment.line.shebang"], { foreground: c.brightCyan, fontStyle: "italic" }],
    ["Shell builtins", ["support.function.builtin.shell", "support.function.unix.shell"], { foreground: c.blue }],
    ["Shell variables", ["variable.other.normal.shell", "variable.parameter.positional.shell", "variable.language.special.shell"], { foreground: c.brightYellow }],
  ];

  return rules.map(([name, scope, settings]) => ({ name, scope, settings }));
}

function workbench(c, ch, isDark) {
  const onAccent = isDark ? c.bg : c.panel;
  return {
    focusBorder: c.link,
    foreground: c.fg,
    descriptionForeground: ch.mutedText,
    errorForeground: c.brightRed,
    "icon.foreground": c.fg,
    "editor.background": c.bg,
    "editor.foreground": c.fg,
    "editorLineNumber.foreground": ch.dimText,
    "editorLineNumber.activeForeground": ch.mutedText,
    "editorCursor.foreground": c.acc,
    "editor.selectionBackground": alpha(c.selection, "55"),
    "editor.inactiveSelectionBackground": alpha(c.selection, "33"),
    "editor.lineHighlightBackground": alpha(c.line, "66"),
    "editor.wordHighlightBackground": alpha(c.selection, "33"),
    "editor.findMatchBackground": alpha(c.acc, "66"),
    "editor.findMatchHighlightBackground": alpha(c.acc, "44"),
    "editorWhitespace.foreground": c.line,
    "editorIndentGuide.background1": c.line,
    "editorIndentGuide.activeBackground1": ch.dimText,
    "editorBracketMatch.background": alpha(c.link, "33"),
    "editorBracketMatch.border": c.link,
    "editorWidget.background": ch.surface,
    "editorWidget.border": c.line,
    "editorHoverWidget.background": ch.surface,
    "editorHoverWidget.border": c.line,
    "editorSuggestWidget.background": ch.surface,
    "editorSuggestWidget.border": c.line,
    "editorSuggestWidget.selectedBackground": c.activebg,
    "editorGroupHeader.tabsBackground": ch.chrome,
    "editorGroup.border": c.line,
    "editorGutter.addedBackground": c.good,
    "editorGutter.deletedBackground": c.warn,
    "editorGutter.modifiedBackground": c.acc,
    "sideBar.background": ch.chrome,
    "sideBar.foreground": c.fg,
    "sideBar.border": c.line,
    "sideBarTitle.foreground": c.fg,
    "sideBarSectionHeader.background": c.bg,
    "sideBarSectionHeader.foreground": ch.mutedText,
    "sideBarSectionHeader.border": c.line,
    "activityBar.background": ch.chromeDeep,
    "activityBar.foreground": c.fg,
    "activityBar.inactiveForeground": ch.dimText,
    "activityBar.border": c.line,
    "activityBarBadge.background": c.link,
    "activityBarBadge.foreground": onAccent,
    "titleBar.activeBackground": ch.chromeDeep,
    "titleBar.activeForeground": c.fg,
    "titleBar.inactiveBackground": ch.chromeDeep,
    "titleBar.inactiveForeground": ch.dimText,
    "titleBar.border": c.line,
    "statusBar.background": ch.chromeDeep,
    "statusBar.foreground": c.fg,
    "statusBar.border": c.line,
    "statusBar.debuggingBackground": c.acc,
    "statusBar.debuggingForeground": onAccent,
    "statusBar.noFolderBackground": ch.chromeDeep,
    "statusBarItem.remoteBackground": c.cyan,
    "statusBarItem.remoteForeground": onAccent,
    "tab.activeBackground": c.bg,
    "tab.activeForeground": c.fg,
    "tab.inactiveBackground": ch.chrome,
    "tab.inactiveForeground": ch.mutedText,
    "tab.border": c.line,
    "tab.activeBorderTop": c.acc,
    "panel.background": ch.chrome,
    "panel.border": c.line,
    "panelTitle.activeForeground": c.fg,
    "panelTitle.inactiveForeground": ch.mutedText,
    "panelTitle.activeBorder": c.acc,
    "terminal.background": c.bg,
    "terminal.foreground": c.fg,
    "terminal.ansiBlack": isDark ? c.ansi[0] : c.ansi[7],
    "terminal.ansiRed": c.red,
    "terminal.ansiGreen": c.green,
    "terminal.ansiYellow": c.yellow,
    "terminal.ansiBlue": c.blue,
    "terminal.ansiMagenta": c.magenta,
    "terminal.ansiCyan": c.cyan,
    "terminal.ansiWhite": isDark ? c.white : c.line,
    "terminal.ansiBrightBlack": c.brightBlack,
    "terminal.ansiBrightRed": c.brightRed,
    "terminal.ansiBrightGreen": c.brightGreen,
    "terminal.ansiBrightYellow": c.brightYellow,
    "terminal.ansiBrightBlue": c.brightBlue,
    "terminal.ansiBrightMagenta": c.brightMagenta,
    "terminal.ansiBrightCyan": c.brightCyan,
    "terminal.ansiBrightWhite": isDark ? c.brightWhite : ch.surface,
    "button.background": c.link,
    "button.foreground": onAccent,
    "button.hoverBackground": c.brightBlue,
    "button.secondaryBackground": c.line,
    "button.secondaryForeground": c.fg,
    "button.secondaryHoverBackground": ch.lineHover,
    "input.background": ch.surface,
    "input.foreground": c.fg,
    "input.border": c.line,
    "input.placeholderForeground": ch.dimText,
    "inputOption.activeBorder": c.link,
    "inputOption.activeBackground": alpha(c.selection, "33"),
    "inputValidation.errorBackground": mix(c.bg, c.warn, 0.15),
    "inputValidation.errorBorder": c.warn,
    "inputValidation.warningBackground": mix(c.bg, c.acc, 0.15),
    "inputValidation.warningBorder": c.acc,
    "inputValidation.infoBackground": mix(c.bg, c.link, 0.15),
    "inputValidation.infoBorder": c.link,
    "dropdown.background": ch.surface,
    "dropdown.foreground": c.fg,
    "dropdown.border": c.line,
    "dropdown.listBackground": ch.surface,
    "list.activeSelectionBackground": c.activebg,
    "list.activeSelectionForeground": isDark ? c.brightWhite : c.fg,
    "list.inactiveSelectionBackground": ch.selectSoft,
    "list.hoverBackground": ch.hover,
    "list.focusBackground": c.activebg,
    "list.highlightForeground": c.acc,
    "list.errorForeground": c.brightRed,
    "list.warningForeground": c.brightYellow,
    "badge.background": c.link,
    "badge.foreground": onAccent,
    "progressBar.background": c.acc,
    "scrollbarSlider.background": alpha(c.line, "88"),
    "scrollbarSlider.hoverBackground": alpha(ch.lineHover, "aa"),
    "scrollbarSlider.activeBackground": alpha(c.link, "66"),
    "gitDecoration.addedResourceForeground": c.good,
    "gitDecoration.modifiedResourceForeground": c.acc,
    "gitDecoration.deletedResourceForeground": c.warn,
    "gitDecoration.untrackedResourceForeground": c.cyan,
    "gitDecoration.ignoredResourceForeground": ch.dimText,
    "gitDecoration.conflictingResourceForeground": c.magenta,
    "peekView.border": c.link,
    "peekViewEditor.background": ch.chrome,
    "peekViewResult.background": c.bg,
    "peekViewTitle.background": ch.surface,
    "notifications.background": ch.surface,
    "notifications.foreground": c.fg,
    "notifications.border": c.line,
    "notificationCenterHeader.background": ch.chrome,
    "textLink.foreground": c.brightBlue,
    "textLink.activeForeground": mix(c.brightBlue, c.fg, 0.2),
    "textBlockQuote.background": ch.surface,
    "textBlockQuote.border": c.link,
    "textCodeBlock.background": ch.surface,
    "textPreformat.foreground": c.acc,
    "widget.shadow": isDark ? "#00000066" : "#00000022",
    "widget.border": c.line,
    "toolbar.hoverBackground": c.activebg,
    "editorOverviewRuler.border": c.line,
    "editorOverviewRuler.addedForeground": alpha(c.good, "88"),
    "editorOverviewRuler.modifiedForeground": alpha(c.acc, "88"),
    "editorOverviewRuler.deletedForeground": alpha(c.warn, "88"),
    "diffEditor.insertedTextBackground": alpha(c.good, "22"),
    "diffEditor.removedTextBackground": alpha(c.warn, "22"),
    "diffEditor.insertedLineBackground": alpha(c.good, "18"),
    "diffEditor.removedLineBackground": alpha(c.warn, "18"),
    "charts.red": c.red,
    "charts.green": c.green,
    "charts.yellow": c.yellow,
    "charts.blue": c.blue,
    "charts.purple": c.magenta,
    "charts.orange": c.brightRed,
    "charts.foreground": c.fg,
    "testing.iconPassed": c.good,
    "testing.iconFailed": c.warn,
    "editorWarning.foreground": c.acc,
    "editorError.foreground": c.brightRed,
    "editorInfo.foreground": c.link,
    disabledForeground: ch.dimText,
  };
}

function buildTheme(palette, mode) {
  const isDark = mode === "dark";
  const c = resolveMode(palette, mode);
  const ch = buildChrome(c, isDark);
  const label = isDark ? "Kettle Dark" : "Kettle Light";
  return {
    name: label,
    type: isDark ? "dark" : "light",
    colors: workbench(c, ch, isDark),
    tokenColors: tokenColors(c, ch),
  };
}

function stableStringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

const src = findPalette();
if (!src) {
  console.error(
    "sync-palette: cannot find kettle-core/static/kettle-palette.json\n" +
      "  Set KETTLE_SRC to the core repo root, or KETTLE_PALETTE to the file.\n" +
      "  Tried:\n" +
      candidates()
        .map((c) => `    ${c}`)
        .join("\n"),
  );
  process.exit(1);
}

const palette = JSON.parse(fs.readFileSync(src, "utf8"));
if (palette.id !== "kettle") {
  console.error(`sync-palette: expected palette id "kettle", got ${palette.id}`);
  process.exit(1);
}

const generated = {
  dark: buildTheme(palette, "dark"),
  light: buildTheme(palette, "light"),
};

let dirty = false;
for (const mode of ["dark", "light"]) {
  const body = stableStringify(generated[mode]);
  const out = OUT[mode];
  const prev = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (prev === body) {
    console.log(`sync-palette: ${path.relative(pkgRoot, out)} up to date`);
    continue;
  }
  dirty = true;
  if (checkOnly) {
    console.error(
      `sync-palette: ${path.relative(pkgRoot, out)} differs from core palette\n` +
        "  Run npm run sync-palette and commit the generated themes.",
    );
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, "utf8");
    console.log(
      `sync-palette: wrote ${path.relative(pkgRoot, out)} from ${path.relative(process.cwd(), src)}`,
    );
  }
}

if (checkOnly && dirty) process.exit(1);
if (!dirty) {
  console.log(`sync-palette: kettle themes match ${path.relative(process.cwd(), src)}`);
}
