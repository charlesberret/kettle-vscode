import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, after } from "node:test";
import { parseDiscoveryToken, readDiscoveryToken } from "../api";

/**
 * The core requires X-Kettle-Token on every /api/ route (LAB-63,
 * kettle-core/docs/AUTH-TOKEN.md). These cover reading that token from the
 * discovery record so the client can attach it.
 */
describe("parseDiscoveryToken", () => {
  it("extracts a token from a full discovery record", () => {
    const raw = JSON.stringify({ port: 4242, url: "http://127.0.0.1:4242/", token: "abc123" });
    assert.equal(parseDiscoveryToken(raw), "abc123");
  });

  it("returns null when the token is absent", () => {
    assert.equal(parseDiscoveryToken(JSON.stringify({ port: 4242 })), null);
  });

  it("returns null for an empty token", () => {
    assert.equal(parseDiscoveryToken(JSON.stringify({ token: "" })), null);
  });

  it("returns null for a non-string token", () => {
    assert.equal(parseDiscoveryToken(JSON.stringify({ token: 12345 })), null);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseDiscoveryToken("{not json"), null);
  });
});

describe("readDiscoveryToken", () => {
  let tmp = "";
  let savedHome: string | undefined;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kettle-token-home-"));
    savedHome = process.env.HOME;
    process.env.HOME = tmp;
  });
  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads the token from ~/.cache/kettle/server.json", () => {
    const dir = path.join(tmp, ".cache", "kettle");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "server.json"),
      JSON.stringify({ port: 4242, token: "live-token-xyz" }),
    );
    assert.equal(readDiscoveryToken(), "live-token-xyz");
  });

  it("returns null when the discovery record is missing", () => {
    fs.rmSync(path.join(tmp, ".cache", "kettle", "server.json"), { force: true });
    assert.equal(readDiscoveryToken(), null);
  });
});
