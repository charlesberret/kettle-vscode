import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ensureCore,
  portFromBaseUrl,
  resolveKettleCommand,
} from "../sidecar";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function pingResponse(port: number, app = "kettle"): Response {
  return new Response(
    JSON.stringify({
      app,
      version: "0.2.0",
      api_version: 0,
      desk_schema_version: 0,
      pid: 4242,
      port,
      curator: {
        provider: "claude",
        command: "claude",
        command_resolved: "claude",
        command_exists: true,
        models: { chat: "sonnet", setup: "sonnet" },
        effort: "default",
        stream: "stream-json",
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("sidecar port helpers", () => {
  it("reads explicit ports from base URLs", () => {
    assert.equal(portFromBaseUrl("http://127.0.0.1:4242"), 4242);
    assert.equal(portFromBaseUrl("http://127.0.0.1:4242/"), 4242);
    assert.equal(portFromBaseUrl("http://127.0.0.1:9999/path"), 9999);
  });

  it("falls back to protocol defaults when the URL omits a port", () => {
    assert.equal(portFromBaseUrl("http://127.0.0.1"), 80);
    assert.equal(portFromBaseUrl("https://example.com"), 443);
    assert.equal(portFromBaseUrl("not a url"), null);
  });
});

describe("resolveKettleCommand", () => {
  it("keeps an absolute existing path", () => {
    const abs = process.execPath;
    assert.equal(resolveKettleCommand(abs), abs);
  });

  it("returns the configured token when no known install is present", () => {
    // Relative tokens stay as-is so PATH resolution happens at spawn time.
    assert.equal(resolveKettleCommand("kettle"), "kettle");
  });
});

describe("ensureCore attach / auto-start gate", () => {
  it("attaches to a healthy preferred core without spawning", async () => {
    let calls = 0;
    globalThis.fetch = async (input) => {
      calls += 1;
      const url = String(input);
      assert.match(url, /\/api\/ping$/);
      return pingResponse(5555);
    };

    const state = await ensureCore({
      preferredUrl: "http://127.0.0.1:5555",
      command: "/nonexistent/kettle-should-not-run",
      autoStart: true,
    });

    assert.equal(state.baseUrl, "http://127.0.0.1:5555");
    assert.equal(state.ownedProcess, null);
    assert.equal(calls, 1);
  });

  it("accepts transitional setsweep identity on attach", async () => {
    globalThis.fetch = async () => pingResponse(5556, "setsweep");

    const state = await ensureCore({
      preferredUrl: "http://127.0.0.1:5556",
      command: "/nonexistent/kettle-should-not-run",
      autoStart: false,
    });

    assert.equal(state.baseUrl, "http://127.0.0.1:5556");
    assert.equal(state.ownedProcess, null);
  });

  it("refuses to spawn when autoStart is false and core is down", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    await assert.rejects(
      () =>
        ensureCore({
          preferredUrl: "http://127.0.0.1:5557",
          command: "/nonexistent/kettle-should-not-run",
          autoStart: false,
        }),
      /not reachable|autoStartServer/,
    );
  });

  it("rejects a foreign app on the preferred port (attach path)", async () => {
    globalThis.fetch = async () => pingResponse(5558, "not-kettle");

    await assert.rejects(
      () =>
        ensureCore({
          preferredUrl: "http://127.0.0.1:5558",
          command: "/nonexistent/kettle-should-not-run",
          autoStart: false,
        }),
      /not reachable|autoStartServer/,
    );
  });
});
