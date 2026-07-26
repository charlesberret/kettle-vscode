import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KettleCompatibilityError,
  assertCoreCompatibility,
  checkCoreCompatibility,
  compatibilityManifest,
  type CompatibilityManifest,
} from "../compatibility";

const manifest: CompatibilityManifest = {
  api_versions: [0],
  desk_schema_versions: [0],
  allow_legacy_identity: false,
};

describe("core compatibility", () => {
  it("loads the packaged declaration", () => {
    assert.deepEqual(compatibilityManifest(), manifest);
  });

  it("accepts the declared API and desk schema", () => {
    assert.deepEqual(
      checkCoreCompatibility(
        { version: "0.2.0", api_version: 0, desk_schema_version: 0 },
        manifest,
      ),
      { ok: true, legacy: false },
    );
  });

  it("rejects a fully legacy identity for the 0.6.65 release", () => {
    const result = checkCoreCompatibility({}, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.legacy, true);
    assert.match(result.message || "", /does not publish API and desk-schema versions/);
  });

  it("rejects a partial identity instead of treating it as legacy", () => {
    const result = checkCoreCompatibility({ api_version: 0 }, manifest);
    assert.equal(result.ok, false);
    assert.equal(result.legacy, false);
    assert.match(result.message || "", /incomplete contract identity/);
  });

  it("rejects unsupported known contracts with a typed error", () => {
    assert.throws(
      () =>
        assertCoreCompatibility({
          version: "2.0.0",
          api_version: 1,
          desk_schema_version: 0,
        }),
      KettleCompatibilityError,
    );
  });
});
