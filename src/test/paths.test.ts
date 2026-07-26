import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  findEntryForEditorPath,
  isUnderKettleDesk,
  kettleDeskDir,
} from "../paths";
import { entryDisplayPath, tryRealpath } from "../project";
import { buildSelectionProbe } from "../selectionSync";

describe("findEntryForEditorPath", () => {
  let tmp = "";
  let realRoot = "";
  let linkRoot = "";
  let fileReal = "";
  let fileViaLink = "";

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-path-"));
    realRoot = path.join(tmp, "real-project");
    fs.mkdirSync(path.join(realRoot, "docs"), { recursive: true });
    fileReal = path.join(realRoot, "docs", "note.md");
    fs.writeFileSync(fileReal, "x\n");

    linkRoot = path.join(tmp, "link-project");
    try {
      fs.symlinkSync(realRoot, linkRoot, "dir");
    } catch {
      // Windows without symlink privilege — skip link cases in those tests
      linkRoot = "";
    }
    if (linkRoot) {
      fileViaLink = path.join(linkRoot, "docs", "note.md");
    }
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("matches absolute path under project root", () => {
    const entries = [{ id: "1", path: fileReal, status: "pending" }];
    assert.equal(findEntryForEditorPath(fileReal, entries, realRoot)?.id, "1");
  });

  it("matches relative path entry when editor is absolute", () => {
    const entries = [{ id: "2", path: "docs/note.md", status: "pending" }];
    assert.equal(findEntryForEditorPath(fileReal, entries, realRoot)?.id, "2");
  });

  it("matches via symlink root (Repos-style alias)", () => {
    if (!linkRoot || !fs.existsSync(fileViaLink)) {
      // OS/environment without symlink support
      return;
    }
    // Registry has real root; editor opens through symlink path
    const entries = [{ id: "3", path: fileReal, status: "pending" }];
    assert.equal(findEntryForEditorPath(fileViaLink, entries, realRoot)?.id, "3");

    // Registry has symlink root; editor uses real path
    const entries2 = [{ id: "4", path: "docs/note.md", status: "pending" }];
    assert.equal(findEntryForEditorPath(fileReal, entries2, linkRoot)?.id, "4");
  });

  it("matches unique basename as last resort", () => {
    const entries = [
      { id: "a", path: "/elsewhere/only-one.md", status: "pending" },
    ];
    assert.equal(
      findEntryForEditorPath("/tmp/foo/only-one.md", entries, realRoot)?.id,
      "a",
    );
  });

  it("returns undefined when basename is ambiguous", () => {
    const entries = [
      { id: "a", path: "/x/same.md", status: "pending" },
      { id: "b", path: "/y/same.md", status: "pending" },
    ];
    assert.equal(findEntryForEditorPath("/z/same.md", entries, realRoot), undefined);
  });
});

describe("kettleDeskDir / isUnderKettleDesk", () => {
  it("joins .kettle under the project root", () => {
    assert.equal(kettleDeskDir("/work/alpha"), path.join("/work/alpha", ".kettle"));
    assert.equal(kettleDeskDir("/work/alpha/"), path.join("/work/alpha", ".kettle"));
  });

  it("detects desk folder and children", () => {
    const root = "/work/alpha";
    const desk = kettleDeskDir(root);
    assert.equal(isUnderKettleDesk(desk, root), true);
    assert.equal(isUnderKettleDesk(path.join(desk, "DESK-PROPOSAL.md"), root), true);
    assert.equal(isUnderKettleDesk(path.join(desk, "runtime", "x.json"), root), true);
    assert.equal(isUnderKettleDesk(path.join(root, "README.md"), root), false);
    assert.equal(isUnderKettleDesk(desk, undefined), false);
  });
});

describe("buildSelectionProbe", () => {
  it("reports match and per-row flags", () => {
    const root = "/Users/x/proj";
    const file = "/Users/x/proj/docs/a.md";
    const probe = buildSelectionProbe({
      reason: "test",
      editorFsPath: file,
      projectId: "p",
      projectRoot: root,
      entries: [{ id: "1", path: "docs/a.md" }, { id: "2", path: "docs/b.md" }],
    });
    assert.equal(probe.matchId, "1");
    assert.equal(probe.entryCount, 2);
    assert.ok(probe.rows.some((r) => r.id === "1"));
  });

  it("notes empty queue", () => {
    const probe = buildSelectionProbe({
      reason: "test",
      editorFsPath: "/x",
      projectId: "p",
      projectRoot: "/x",
      entries: [],
    });
    assert.equal(probe.matchId, null);
    assert.ok(probe.notes.some((n) => /empty/i.test(n)));
  });
});

describe("entryDisplayPath + tryRealpath smoke", () => {
  it("strips root", () => {
    assert.equal(
      entryDisplayPath("/Users/x/p/docs/a.md", "/Users/x/p"),
      "docs/a.md",
    );
  });
  it("tryRealpath returns a string", () => {
    assert.equal(typeof tryRealpath(process.cwd()), "string");
  });
});
