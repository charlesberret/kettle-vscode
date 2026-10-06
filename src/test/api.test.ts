import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { KettleApi, KettleApiError, type StreamEvent } from "../api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GET /api/ping contract shape", () => {
  it("surfaces identity and curator public fields from core", async () => {
    globalThis.fetch = async (input) => {
      assert.equal(new URL(String(input)).pathname, "/api/ping");
      return new Response(
        JSON.stringify({
          app: "kettle",
          version: "0.2.0",
          api_version: 0,
          desk_schema_version: 0,
          pid: 11,
          port: 4242,
          started: "2026-07-11T14:00:00-0400",
          projects: "/tmp/projects.json",
          settings: "/tmp/settings.json",
          curator: {
            provider: "claude",
            command: "claude",
            command_resolved: "/usr/bin/claude",
            command_exists: true,
            models: { chat: "sonnet", setup: "sonnet" },
            effort: "default",
            efforts: { setup: "default", chat: "default" },
            stream: "stream-json",
            capabilities: {
              read_only_tier: true,
              tool_allowlist: true,
              resume: true,
              effort: true,
              fenced_writes: true,
            },
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const ping = await new KettleApi("http://127.0.0.1:4242").ping();
    assert.equal(ping.app, "kettle");
    assert.equal(ping.api_version, 0);
    assert.equal(ping.desk_schema_version, 0);
    assert.equal(ping.port, 4242);
    assert.equal(ping.curator?.effort, "default");
    assert.equal(ping.curator?.stream, "stream-json");
    assert.equal(ping.curator?.capabilities?.fenced_writes, true);
  });
});

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(line));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );
}

describe("canonical ritual API routes", () => {
  it("posts propose, found, and compact to their distinct core routes", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      });
      return ndjsonResponse(['{"t":"text","s":"ok"}\n']);
    };
    const api = new KettleApi("http://127.0.0.1:4242");

    await api.propose("alpha");
    await api.found("alpha");
    await api.compact("alpha");

    assert.deepEqual(
      calls.map((c) => new URL(c.url).pathname),
      ["/api/propose", "/api/found", "/api/compact"],
    );
    assert.deepEqual(
      calls.map((c) => c.body),
      [{ project: "alpha" }, { project: "alpha" }, { project: "alpha" }],
    );
  });

  it("parses fragmented NDJSON and forwards activity events", async () => {
    const seen: StreamEvent[] = [];
    globalThis.fetch = async () =>
      ndjsonResponse([
        '{"t":"activity","kind":"thought","s":"checking"}\n{"t":"te',
        'xt","s":"done"}\n',
      ]);

    const result = await new KettleApi("http://127.0.0.1:4242").found(
      "alpha",
      { onEvent: (event) => seen.push(event) },
    );

    assert.equal(result.text, "done");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].t, "activity");
    assert.equal(seen[1].t, "text");
  });

  it("surfaces streamed core errors", async () => {
    globalThis.fetch = async () =>
      ndjsonResponse(['{"t":"error","s":"founding failed"}\n']);

    await assert.rejects(
      () => new KettleApi("http://127.0.0.1:4242").found("alpha"),
      (error: unknown) =>
        error instanceof KettleApiError &&
        error.message === "founding failed",
    );
  });
});

describe("POST /api/set-aside (Not this)", () => {
  it("sets a file aside with {project, id}, and brings it back with undo", async () => {
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      calls.push({ method: String(init?.method), path: new URL(String(input)).pathname, body });
      return new Response(
        JSON.stringify({ ok: true, status: body.undo ? "pending" : "set-aside" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const api = new KettleApi("http://127.0.0.1:4242");

    const aside = await api.setAside("alpha", "e1");
    const back = await api.setAside("alpha", "e1", { undo: true });

    assert.deepEqual(calls, [
      { method: "POST", path: "/api/set-aside", body: { project: "alpha", id: "e1" } },
      { method: "POST", path: "/api/set-aside", body: { project: "alpha", id: "e1", undo: true } },
    ]);
    assert.equal(aside.status, "set-aside");
    assert.equal(back.status, "pending");
  });

  it("surfaces core's refusal of the proposal as its own message", async () => {
    const refusal = "The proposal can't be set aside — edit it, or ask the agent to rewrite it.";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: refusal }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    await assert.rejects(
      () => new KettleApi("http://127.0.0.1:4242").setAside("alpha", "desk-proposal"),
      (error: unknown) =>
        error instanceof KettleApiError && error.status === 400 && error.message === refusal,
    );
  });
});
