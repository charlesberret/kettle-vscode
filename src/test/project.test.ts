import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveProjectId,
  entryDisplayPath,
  workspaceMatchesProject,
  sortQueueForDisplay,
  nextPendingEntry,
  isApprovedEntry,
  nameFromRootPath,
  findProjectByRoot,
} from "../project";

const projects = [
  { id: "career", name: "Career", root: "/Users/x/Sync/Career" },
  { id: "system", name: "System", root: "/Users/x/Sync/System" },
  {
    id: "sample-site",
    name: "Sample Site",
    root: "/Users/x/Work/sample-site",
  },
];

describe("resolveProjectId", () => {
  it("uses configured id when present", () => {
    assert.equal(
      resolveProjectId(projects, "system", ["/Users/x/Sync/Career"]),
      "system",
    );
  });
  it("returns undefined for unknown configured id", () => {
    assert.equal(
      resolveProjectId(projects, "nope", ["/Users/x/Sync/Career"]),
      undefined,
    );
  });
  it("returns undefined for unknown configured id even with single project", () => {
    assert.equal(
      resolveProjectId([projects[0]], "nope", ["/Users/x/Sync/Career"]),
      undefined,
    );
  });
  it("matches single workspace folder under a project root", () => {
    assert.equal(
      resolveProjectId(projects, "", ["/Users/x/Sync/Career/JobMaterials"]),
      "career",
    );
  });
  it("matches exact project root", () => {
    assert.equal(
      resolveProjectId(projects, "", ["/Users/x/Sync/Career"]),
      "career",
    );
  });
  it("returns undefined when multiple projects match", () => {
    assert.equal(
      resolveProjectId(projects, "", [
        "/Users/x/Sync/Career",
        "/Users/x/Sync/System",
      ]),
      undefined,
    );
  });
  it("returns sole project when no workspace folders", () => {
    assert.equal(resolveProjectId([projects[0]], "", []), "career");
  });
  it("does NOT return sole project when workspace is a different folder", () => {
    // An unrelated open folder must not bind to the only registered project.
    assert.equal(
      resolveProjectId(
        [projects[2]],
        "",
        ["/Users/x/Work/other-project"],
      ),
      undefined,
    );
  });
  it("does NOT match a project that merely lives under the open parent folder", () => {
    assert.equal(
      resolveProjectId(
        [projects[2]],
        "",
        ["/Users/x/Work"],
      ),
      undefined,
    );
  });
  it("matches sole project when workspace is that project", () => {
    assert.equal(
      resolveProjectId(
        [projects[2]],
        "",
        ["/Users/x/Work/sample-site"],
      ),
      "sample-site",
    );
  });
});

describe("workspaceMatchesProject", () => {
  it("accepts root and descendants only", () => {
    const root = "/Users/x/Work/sample-project";
    assert.equal(workspaceMatchesProject([root], root), true);
    assert.equal(workspaceMatchesProject([root + "/src"], root), true);
    assert.equal(
      workspaceMatchesProject(["/Users/x/Work"], root),
      false,
    );
    assert.equal(
      workspaceMatchesProject(
        ["/Users/x/Work/other-project"],
        root,
      ),
      false,
    );
  });
  it("matches a symlink alias to the same real project root", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-project-"));
    const actual = path.join(temp, "actual");
    const alias = path.join(temp, "alias");
    fs.mkdirSync(actual);
    try {
      fs.symlinkSync(actual, alias, "dir");
    } catch {
      fs.rmSync(temp, { recursive: true, force: true });
      return;
    }
    try {
      assert.equal(workspaceMatchesProject([alias], actual), true);
      assert.equal(workspaceMatchesProject([actual], alias), true);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("nameFromRootPath", () => {
  it("title-cases basename and expands separators", () => {
    assert.equal(nameFromRootPath("/Users/x/my-notes"), "My Notes");
    assert.equal(nameFromRootPath("/Users/x/sample_site"), "Sample Site");
    assert.equal(nameFromRootPath("/Users/x/foo_bar/"), "Foo Bar");
  });
  it("returns empty for blank", () => {
    assert.equal(nameFromRootPath(""), "");
  });
});

describe("findProjectByRoot", () => {
  it("matches lexical root", () => {
    const hit = findProjectByRoot(projects, "/Users/x/Sync/Career");
    assert.equal(hit?.id, "career");
  });
  it("returns undefined when unregistered", () => {
    assert.equal(
      findProjectByRoot(projects, "/Users/x/Work/other-project"),
      undefined,
    );
  });
});

describe("entryDisplayPath", () => {
  it("strips project root prefix", () => {
    assert.equal(
      entryDisplayPath(
        "/Users/x/Sync/Career/target-companies.md",
        "/Users/x/Sync/Career",
      ),
      "target-companies.md",
    );
  });
  it("strips nested relative segments", () => {
    assert.equal(
      entryDisplayPath(
        "/Users/x/Sync/Career/docs/a.md",
        "/Users/x/Sync/Career",
      ),
      "docs/a.md",
    );
  });
});

describe("sortQueueForDisplay / nextPendingEntry", () => {
  const entries = [
    { id: "1", path: "a.md", status: "pending" },
    { id: "2", path: "b.md", status: "approved" },
    { id: "3", path: "c.md", status: "pending" },
  ];
  it("moves approved to the bottom", () => {
    assert.deepEqual(
      sortQueueForDisplay(entries).map((e) => e.id),
      ["1", "3", "2"],
    );
  });
  it("detects approved", () => {
    assert.equal(isApprovedEntry(entries[1]), true);
    assert.equal(isApprovedEntry(entries[0]), false);
  });
  it("picks next pending after the approved id", () => {
    // Still in list as pending → next after 1 is 3
    assert.equal(nextPendingEntry(entries, "1")?.id, "3");
    // After refresh, 1 is approved → first remaining pending is 3
    const afterRefresh = [
      { id: "1", path: "a.md", status: "approved" },
      { id: "2", path: "b.md", status: "approved" },
      { id: "3", path: "c.md", status: "pending" },
    ];
    assert.equal(nextPendingEntry(afterRefresh, "1")?.id, "3");
  });
});
