import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { KettleApi, KettleApiError, type StreamEvent } from "../api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
