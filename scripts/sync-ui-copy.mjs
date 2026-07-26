#!/usr/bin/env node
/**
 * Generate the committed src/uiCopy.ts snapshot from the canonical core copy.
 *
 * Explicit maintainer action. Ordinary compile/package use the committed snapshot.
 *
 * Resolution order:
 *   1. KETTLE_UI_COPY / SETSWEEP_UI_COPY (absolute path to ui-copy.js)
 *   2. KETTLE_SRC / SETSWEEP_SRC + /static/ui-copy.js
 *   3. Sibling checkouts: ../kettle, ../setsweep-core, …
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

function candidates() {
  const list = [];
  for (const env of ["KETTLE_UI_COPY", "SETSWEEP_UI_COPY"]) {
    if (process.env[env]) list.push(process.env[env]);
  }
  for (const env of ["KETTLE_SRC", "SETSWEEP_SRC"]) {
    if (process.env[env]) {
      list.push(path.join(process.env[env], "static", "ui-copy.js"));
    }
  }
  // kettle-vscode next to kettle / setsweep-core
  list.push(
    path.resolve(pkgRoot, "../kettle/static/ui-copy.js"),
    path.resolve(pkgRoot, "../setsweep-core/static/ui-copy.js"),
    path.resolve(pkgRoot, "../../kettle/static/ui-copy.js"),
    path.resolve(pkgRoot, "../../setsweep-core/static/ui-copy.js"),
  );
  const home = process.env.HOME || "";
  if (home) {
    list.push(
      path.join(home, "cloud/git-projects/kettle/static/ui-copy.js"),
      path.join(home, "cloud/git-projects/setsweep-core/static/ui-copy.js"),
      path.join(home, "Repos/kettle/static/ui-copy.js"),
      path.join(home, "Repos/setsweep-core/static/ui-copy.js"),
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

function tsString(s) {
  return JSON.stringify(s);
}

function generate(copy) {
  const keys = Object.keys(copy);
  const lines = keys.map((k) => {
    const v = copy[k];
    if (typeof v !== "string") {
      throw new Error(`ui-copy key ${k} must be a string, got ${typeof v}`);
    }
    return `  ${k}: ${tsString(v)},`;
  });
  return `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: core static/ui-copy.js (kettle or setsweep-core)
 * Regenerate: npm run sync-ui-copy
 *
 * Canonical sitting UI copy for the Desk webview.
 */
export const UI_COPY = {
${lines.join("\n")}
} as const;

export type UiCopyKey = keyof typeof UI_COPY;
`;
}

const src = findSource();
if (!src) {
  console.error(
    "sync-ui-copy: cannot find core static/ui-copy.js\n" +
      "  Set KETTLE_SRC (or SETSWEEP_SRC) to the core repo root.\n" +
      "  Tried:\n" +
      candidates()
        .map((c) => `    ${c}`)
        .join("\n"),
  );
  process.exit(1);
}

const copy = require(src);
if (!copy || typeof copy !== "object") {
  console.error("sync-ui-copy: ui-copy.js did not export a COPY object");
  process.exit(1);
}

const body = generate(copy);
const prev = fs.existsSync(outTs) ? fs.readFileSync(outTs, "utf8") : "";
if (prev === body) {
  console.log(`sync-ui-copy: up to date (${path.relative(pkgRoot, src)})`);
} else if (checkOnly) {
  console.error(
    "sync-ui-copy: committed src/uiCopy.ts differs from core static/ui-copy.js\n" +
      "  Run npm run sync-ui-copy and commit the generated snapshot.",
  );
  process.exit(1);
} else {
  fs.writeFileSync(outTs, body, "utf8");
  console.log(
    `sync-ui-copy: wrote src/uiCopy.ts from ${path.relative(process.cwd(), src)} (${Object.keys(copy).length} keys)`,
  );
}
