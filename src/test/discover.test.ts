import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { KettleCompatibilityError } from "../compatibility";
import { resolveCoreBaseUrl } from "../discover";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("core discovery compatibility", () => {
  it("rejects an explicitly configured incompatible core without fallback", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          app: "kettle",
          version: "2.0.0",
          api_version: 1,
          desk_schema_version: 0,
          pid: 123,
          port: 4999,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    await assert.rejects(
      () => resolveCoreBaseUrl("http://127.0.0.1:4999"),
      KettleCompatibilityError,
    );
    assert.equal(calls, 1);
  });
});
