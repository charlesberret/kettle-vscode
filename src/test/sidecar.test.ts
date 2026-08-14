import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import { findCommandInDirs, resolveKettleCommand } from "../sidecar";

/**
 * Regression coverage for core-sidecar launch resolution (LAB-37).
 *
 * GUI-launched editors start with a minimal PATH, so a bare-name spawn of
 * `kettle` can fail. resolveKettleCommand must resolve to an absolute path
 * across the known install dirs; findCommandInDirs is that resolution unit.
 */
describe("findCommandInDirs", () => {
  let tmp = "";
  const mkbin = (dir: string, name: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, "#!/bin/sh\n");
    fs.chmodSync(p, 0o755);
    return p;
  };

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-sidecar-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds a command in a directory", () => {
    const dir = path.join(tmp, "a");
    const bin = mkbin(dir, "kettle");
    assert.equal(findCommandInDirs(["kettle"], [dir]), bin);
  });

  it("returns null when nothing matches", () => {
    assert.equal(findCommandInDirs(["kettle"], [path.join(tmp, "empty")]), null);
  });

  it("prefers the earlier name (kettle) over the legacy name (setsweep)", () => {
    const dirA = path.join(tmp, "legacy");
    const dirB = path.join(tmp, "modern");
    mkbin(dirA, "setsweep");
    const kettle = mkbin(dirB, "kettle");
    // Even though dirA (with setsweep) is searched first, kettle wins because
    // resolution is names-major.
    assert.equal(findCommandInDirs(["kettle", "setsweep"], [dirA, dirB]), kettle);
  });

  it("prefers the earlier directory for the same name", () => {
    const dir1 = path.join(tmp, "first");
    const dir2 = path.join(tmp, "second");
    const first = mkbin(dir1, "kettle");
    mkbin(dir2, "kettle");
    assert.equal(findCommandInDirs(["kettle"], [dir1, dir2]), first);
  });

  it("ignores a directory that shares the command name", () => {
    const dir = path.join(tmp, "dirlike");
    fs.mkdirSync(path.join(dir, "kettle"), { recursive: true }); // a dir, not a file
    assert.equal(findCommandInDirs(["kettle"], [dir]), null);
  });

  it("skips empty-string directories without throwing", () => {
    const dir = path.join(tmp, "withfile");
    const bin = mkbin(dir, "kettle");
    assert.equal(findCommandInDirs(["kettle"], ["", dir]), bin);
  });

  it("falls back to the legacy name when only setsweep is present", () => {
    const dir = path.join(tmp, "onlylegacy");
    const bin = mkbin(dir, "setsweep");
    assert.equal(findCommandInDirs(["kettle", "setsweep"], [dir]), bin);
  });
});

describe("resolveKettleCommand", () => {
  let tmp = "";
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-resolve-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an existing absolute configured path verbatim", () => {
    const bin = path.join(tmp, "kettle");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    assert.equal(resolveKettleCommand(bin), bin);
  });

  it("defaults a blank command to a bare or resolved 'kettle'", () => {
    const resolved = resolveKettleCommand("   ");
    // Either an absolute resolved path, or the bare fallback — never empty.
    assert.ok(resolved === "kettle" || path.isAbsolute(resolved));
  });
});
