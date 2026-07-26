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
  { id: "career", name: "Career", root: "/Users/x/Seafile/Career" },
  { id: "system", name: "System", root: "/Users/x/Seafile/System" },
  {
    id: "charlesberret.net",
    name: "charlesberret.net",
    root: "/Users/x/cloud/git-projects/charlesberret.net",
  },
];

describe("resolveProjectId", () => {
  it("uses configured id when present", () => {
    assert.equal(
      resolveProjectId(projects, "system", ["/Users/x/Seafile/Career"]),
      "system",
    );
  });
  it("returns undefined for unknown configured id", () => {
    assert.equal(
      resolveProjectId(projects, "nope", ["/Users/x/Seafile/Career"]),
      undefined,
    );
  });
  it("returns undefined for unknown configured id even with single project", () => {
    assert.equal(
      resolveProjectId([projects[0]], "nope", ["/Users/x/Seafile/Career"]),
      undefined,
    );
  });
  it("matches single workspace folder under a project root", () => {
    assert.equal(
      resolveProjectId(projects, "", ["/Users/x/Seafile/Career/JobMaterials"]),
      "career",
    );
  });
  it("matches exact project root", () => {
    assert.equal(
      resolveProjectId(projects, "", ["/Users/x/Seafile/Career"]),
      "career",
    );
  });
  it("returns undefined when multiple projects match", () => {
    assert.equal(
      resolveProjectId(projects, "", [
        "/Users/x/Seafile/Career",
        "/Users/x/Seafile/System",
      ]),
      undefined,
    );
  });
  it("returns sole project when no workspace folders", () => {
    assert.equal(resolveProjectId([projects[0]], "", []), "career");
  });
  it("does NOT return sole project when workspace is a different folder", () => {
    // The bug: Proteus open, only charlesberret.net registered → must not auto-bind.
    assert.equal(
      resolveProjectId(
        [projects[2]],
        "",
        ["/Users/x/cloud/git-projects/proteus"],
      ),
      undefined,
    );
  });
  it("does NOT match a project that merely lives under the open parent folder", () => {
    assert.equal(
      resolveProjectId(
        [projects[2]],
        "",
        ["/Users/x/cloud/git-projects"],
      ),
      undefined,
    );
  });
  it("matches sole project when workspace is that project", () => {
    assert.equal(
      resolveProjectId(
        [projects[2]],
        "",
        ["/Users/x/cloud/git-projects/charlesberret.net"],
      ),
      "charlesberret.net",
    );
  });
});

describe("workspaceMatchesProject", () => {
  it("accepts root and descendants only", () => {
    const root = "/Users/x/cloud/git-projects/proteus";
    assert.equal(workspaceMatchesProject([root], root), true);
    assert.equal(workspaceMatchesProject([root + "/src"], root), true);
    assert.equal(
      workspaceMatchesProject(["/Users/x/cloud/git-projects"], root),
      false,
    );
    assert.equal(
      workspaceMatchesProject(
        ["/Users/x/cloud/git-projects/charlesberret.net"],
        root,
      ),
      false,
    );
  });
  it("matches Repos spelling to the same realpath as git-projects when linked", () => {
    // On this machine Repos → cloud/git-projects; skip if not linked.
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const repos = path.join(os.homedir(), "Repos");
    const git = path.join(os.homedir(), "cloud/git-projects");
    let same = false;
    try {
      same = fs.realpathSync(repos) === fs.realpathSync(git);
    } catch {
      same = false;
    }
    if (!same) return; // environment without the symlink
    const desk = "charlesberret.net";
    assert.equal(
      workspaceMatchesProject(
        [path.join(repos, desk)],
        path.join(git, desk),
      ),
      true,
    );
    assert.equal(
      workspaceMatchesProject(
        [path.join(git, desk)],
        path.join(repos, desk),
      ),
      true,
    );
  });
});

describe("nameFromRootPath", () => {
  it("title-cases basename and expands separators", () => {
    assert.equal(nameFromRootPath("/Users/x/my-notes"), "My Notes");
    assert.equal(nameFromRootPath("/Users/x/charlesberret.net"), "Charlesberret.Net");
    assert.equal(nameFromRootPath("/Users/x/foo_bar/"), "Foo Bar");
  });
  it("returns empty for blank", () => {
    assert.equal(nameFromRootPath(""), "");
  });
});

describe("findProjectByRoot", () => {
  it("matches lexical root", () => {
    const hit = findProjectByRoot(projects, "/Users/x/Seafile/Career");
    assert.equal(hit?.id, "career");
  });
  it("returns undefined when unregistered", () => {
    assert.equal(
      findProjectByRoot(projects, "/Users/x/cloud/git-projects/proteus"),
      undefined,
    );
  });
});

describe("entryDisplayPath", () => {
  it("strips project root prefix", () => {
    assert.equal(
      entryDisplayPath(
        "/Users/x/Seafile/Career/target-companies.md",
        "/Users/x/Seafile/Career",
      ),
      "target-companies.md",
    );
  });
  it("strips nested relative segments", () => {
    assert.equal(
      entryDisplayPath(
        "/Users/x/Seafile/Career/docs/a.md",
        "/Users/x/Seafile/Career",
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
