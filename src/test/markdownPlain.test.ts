import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectSummarySentence,
  stripMarkdownToPlain,
} from "../briefText";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("stripMarkdownToPlain", () => {
  it("removes bold markers used in PROJECT.md leads", () => {
    const s = stripMarkdownToPlain(
      "The studio's **project handbook** — a live, deployed site.",
    );
    assert.equal(
      s,
      "The studio's project handbook — a live, deployed site.",
    );
    assert.ok(!s.includes("**"));
  });
  it("unwraps links and code", () => {
    assert.equal(
      stripMarkdownToPlain("See [docs](https://example.com) and `foo`."),
      "See docs and foo.",
    );
  });
});

describe("projectSummarySentence", () => {
  it("returns plain text from PROJECT.md without raw **", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-md-"));
    try {
      fs.mkdirSync(path.join(dir, ".kettle"));
      fs.writeFileSync(
        path.join(dir, ".kettle", "PROJECT.md"),
        "# Title\n\nThe studio's **project handbook** — a live site.\n\nMore.\n",
        "utf8",
      );
      const out = projectSummarySentence(dir, "example-site");
      assert.ok(out.includes("project handbook"));
      assert.ok(!out.includes("**"), out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
