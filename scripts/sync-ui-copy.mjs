#!/usr/bin/env node
/**
 * Generate the committed src/uiCopy.ts snapshot from the canonical core catalog.
 *
 * Explicit maintainer action. Ordinary compile/package use the committed snapshot,
 * so the extension stays buildable without a core checkout beside it.
 *
 * The canonical catalog is kettle-core `kettle/static/ui-copy.json`. It used to be
 * a JavaScript file; core deleted that because a generated file beside its source
 * is a second source. A `.js` path is still accepted so this script keeps working
 * against an older core checkout.
 *
 * Resolution order:
 *   1. KETTLE_UI_COPY / SETSWEEP_UI_COPY (absolute path to ui-copy.json or .js)
 *   2. KETTLE_SRC / SETSWEEP_SRC + /kettle/static/ui-copy.json
 *   3. Sibling checkouts: ../kettle-core, then legacy ../setsweep-core
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const outTs = path.join(pkgRoot, "src", "uiCopy.ts");
const require = createRequire(import.meta.url);
const checkOnly = process.argv.includes("--check");

const NAMES = ["ui-copy.json", "ui-copy.js"];

function candidates() {
  const list = [];
  for (const env of ["KETTLE_UI_COPY", "SETSWEEP_UI_COPY"]) {
    if (process.env[env]) list.push(process.env[env]);
  }
  for (const env of ["KETTLE_SRC", "SETSWEEP_SRC"]) {
    if (!process.env[env]) continue;
    for (const name of NAMES) {
      list.push(path.join(process.env[env], "kettle", "static", name));
      list.push(path.join(process.env[env], "static", name));
    }
  }
  // kettle-vscode next to kettle-core (or a legacy setsweep-core checkout)
  for (const name of NAMES) {
    list.push(
      path.resolve(pkgRoot, `../kettle-core/kettle/static/${name}`),
      path.resolve(pkgRoot, `../kettle-core/static/${name}`),
      path.resolve(pkgRoot, `../setsweep-core/static/${name}`),
      path.resolve(pkgRoot, `../../kettle-core/kettle/static/${name}`),
      path.resolve(pkgRoot, `../../kettle-core/static/${name}`),
      path.resolve(pkgRoot, `../../setsweep-core/static/${name}`),
    );
  }
  return list;
}

function findSource() {
  for (const p of candidates()) {
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  return null;
}

/**
 * Both catalog shapes reduce to the same two maps.
 *
 * JSON: {keys: {name: {text, short?, note?}}}   — the current catalog
 * JS:   module.exports = {name: "text"}         — an older core checkout
 */
function readCatalog(src) {
  if (src.endsWith(".json")) {
    const raw = JSON.parse(fs.readFileSync(src, "utf8"));
    const keys = raw && raw.keys;
    if (!keys || typeof keys !== "object") {
      throw new Error("ui-copy.json has no `keys` object");
    }
    const text = {};
    const short = {};
    const note = {};
    for (const [k, v] of Object.entries(keys)) {
      if (!v || typeof v.text !== "string") {
        throw new Error(`ui-copy key ${k} has no string \`text\``);
      }
      text[k] = v.text;
      if (typeof v.short === "string" && v.short) short[k] = v.short;
      if (typeof v.note === "string" && v.note) note[k] = v.note;
    }
    return { text, short, note };
  }
  const copy = require(src);
  if (!copy || typeof copy !== "object") {
    throw new Error("ui-copy.js did not export a COPY object");
  }
  const text = {};
  for (const [k, v] of Object.entries(copy)) {
    if (typeof v !== "string") {
      throw new Error(`ui-copy key ${k} must be a string, got ${typeof v}`);
    }
    text[k] = v;
  }
  return { text, short: {}, note: {} };
}

function entries(map, comments) {
  return Object.keys(map)
    .map((k) => {
      const c = comments && comments[k] ? `  /** ${comments[k].replace(/\*\//g, "*\\/")} */\n` : "";
      return `${c}  ${k}: ${JSON.stringify(map[k])},`;
    })
    .join("\n");
}

function generate({ text, short, note }) {
  return `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: kettle-core kettle/static/ui-copy.json
 * Regenerate: npm run sync-ui-copy
 *
 * Canonical sitting UI copy for the Desk webview. Every viewport resolves the same
 * keys, so a string changed in core reaches this one too.
 */
export const UI_COPY = {
${entries(text, note)}
} as const;

/**
 * Terse variants for a surface too narrow for the full string. Same meaning, fewer
 * words — never a different instruction. Absent keys fall back to UI_COPY.
 */
export const UI_COPY_SHORT: Partial<Record<UiCopyKey, string>> = {
${entries(short)}
};

export type UiCopyKey = keyof typeof UI_COPY;

/** The string for \`key\`, preferring the short variant when the surface is narrow. */
export function uiCopy(key: UiCopyKey, opts?: { short?: boolean }): string {
  if (opts?.short) {
    const s = UI_COPY_SHORT[key];
    if (s) return s;
  }
  return UI_COPY[key];
}
`;
}

const src = findSource();
if (!src) {
  console.error(
    "sync-ui-copy: cannot find core kettle/static/ui-copy.json\n" +
      "  Set KETTLE_SRC (or SETSWEEP_SRC) to the core repo root.\n" +
      "  Tried:\n" +
      candidates().map((c) => `    ${c}`).join("\n"),
  );
  process.exit(1);
}

let catalog;
try {
  catalog = readCatalog(src);
} catch (err) {
  console.error(`sync-ui-copy: ${err.message} (${src})`);
  process.exit(1);
}

const body = generate(catalog);
const prev = fs.existsSync(outTs) ? fs.readFileSync(outTs, "utf8") : "";
const n = Object.keys(catalog.text).length;
if (prev === body) {
  console.log(`sync-ui-copy: up to date (${path.relative(pkgRoot, src)}, ${n} keys)`);
} else if (checkOnly) {
  console.error(
    "sync-ui-copy: committed src/uiCopy.ts differs from the core catalog\n" +
      "  Run npm run sync-ui-copy and commit the generated snapshot.",
  );
  process.exit(1);
} else {
  fs.writeFileSync(outTs, body, "utf8");
  console.log(
    `sync-ui-copy: wrote src/uiCopy.ts from ${path.relative(process.cwd(), src)} (${n} keys)`,
  );
}
