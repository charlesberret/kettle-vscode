/**
 * Thin HTTP client for kettle-core localhost API.
 * Approve is a ruling bookmark — never conflate with host "accept diff."
 * Streaming routes (sweep/chat/…) return NDJSON — see kettle-core/API.md.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Discovery record path (mirrors discover.ts; inlined to avoid an import cycle). */
function discoveryPath(): string {
  return path.join(os.homedir(), ".cache", "kettle", "server.json");
}

/**
 * Extract the per-boot auth token from discovery-record JSON, or null.
 * Pure — the unit under test. See kettle-core/docs/AUTH-TOKEN.md.
 */
export function parseDiscoveryToken(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { token?: unknown };
    return typeof data.token === "string" && data.token ? data.token : null;
  } catch {
    return null;
  }
}

/** Current core auth token from `~/.cache/kettle/server.json`, or null. */
export function readDiscoveryToken(): string | null {
  try {
    return parseDiscoveryToken(fs.readFileSync(discoveryPath(), "utf8"));
  } catch {
    return null;
  }
}

export type Project = {
  id: string;
  name: string;
  root: string;
  kit?: string;
};

export type DiffStat = {
  added: number;
  removed: number;
} | null;

export type QueueEntry = {
  id: string | number;
  path: string;
  ask?: string;
  urgency?: string;
  status?: string;
  brief?: string;
  comment?: string;
  approved?: string;
  /** Enriched by GET /api/queue — {added, removed} vs snapshot, or null. */
  diff?: DiffStat;
  title?: string;
  source?: string;
  /** Founding desk-proposal placeholder (`proposal`) vs content work. */
  founding_phase?: string;
};

export type Queue = {
  curated?: string;
  entries?: QueueEntry[];
};

export type Ping = {
  app: string;
  version?: string;
  api_version?: number;
  desk_schema_version?: number;
  pid: number;
  port: number;
  started?: string | null;
  projects?: string;
  settings?: string;
  curator?: {
    provider: string;
    command: string;
    command_resolved?: string;
    command_exists?: boolean;
    models?: Record<string, string>;
  };
};

/** One line from an application/x-ndjson curator stream. */
export type StreamEvent = {
  t: string;
  s?: string;
  tool?: string;
  path?: string;
  /** activity subtype from core (e.g. thought). */
  kind?: string;
  session?: string;
  context?: number;
  peak?: number;
  window?: number;
  error?: string;
  cost?: number;
  [key: string]: unknown;
};

export type StreamResult = {
  events: StreamEvent[];
  text: string;
  error?: string;
};

export type ChatMessage = {
  cls?: string;
  role?: string;
  text?: string;
  content?: string;
  [key: string]: unknown;
};

export class KettleApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KettleApiError";
  }
}

export class KettleApi {
  constructor(private readonly baseUrl: string) {}

  get base(): string {
    return this.baseUrl;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.baseUrl.replace(/\/?$/, "/"));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== "") u.searchParams.set(k, v);
      }
    }
    return u.toString();
  }

  /**
   * Headers for a core request. Every /api/ route requires X-Kettle-Token
   * (kettle-core/docs/AUTH-TOKEN.md); read it fresh from the discovery record so
   * a per-boot rotation is picked up without reconstructing the client.
   */
  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    const token = readDiscoveryToken();
    if (token) h["X-Kettle-Token"] = token;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string | undefined>; body?: unknown },
  ): Promise<T> {
    const res = await fetch(this.url(path, opts?.query), {
      method,
      headers: this.headers(
        opts?.body != null ? { "Content-Type": "application/json" } : undefined,
      ),
      body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new KettleApiError(`Invalid JSON from ${path}`, res.status);
    }
    if (!res.ok) {
      const err =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : res.statusText;
      throw new KettleApiError(err || `HTTP ${res.status}`, res.status);
    }
    return data as T;
  }

  /**
   * POST a streaming (NDJSON) route. Do not use `request()` — those bodies are
   * not a single JSON value.
   */
  async postNdjsonStream(
    path: string,
    body: unknown,
    onEvent?: (ev: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let err = res.statusText;
      try {
        const data = (await res.json()) as { error?: string };
        if (data?.error) err = String(data.error);
      } catch {
        /* non-JSON error body */
      }
      throw new KettleApiError(err || `HTTP ${res.status}`, res.status);
    }
    if (!res.body) {
      throw new KettleApiError(`No body from ${path}`, res.status);
    }

    const events: StreamEvent[] = [];
    const textParts: string[] = [];
    let streamError: string | undefined;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        events.push(ev);
        onEvent?.(ev);
        if (ev.t === "text" && ev.s) textParts.push(ev.s);
        if (ev.t === "error" && ev.s) streamError = ev.s;
      }
    }
    if (buf.trim()) {
      try {
        const ev = JSON.parse(buf) as StreamEvent;
        events.push(ev);
        onEvent?.(ev);
        if (ev.t === "text" && ev.s) textParts.push(ev.s);
        if (ev.t === "error" && ev.s) streamError = ev.s;
      } catch {
        /* trailing partial */
      }
    }

    if (streamError) {
      throw new KettleApiError(streamError, res.status);
    }
    return { events, text: textParts.join(""), error: streamError };
  }

  ping(): Promise<Ping> {
    return this.request("GET", "/api/ping");
  }

  projects(): Promise<{ projects: Project[]; home: string }> {
    return this.request("GET", "/api/projects");
  }

  /**
   * Register a folder in the core registry and seed `.kettle/` when missing.
   * Does not run the founding interview — client binds + begins interview after.
   * Core: POST /api/projects/add (Tier 3). Root must exist under $HOME.
   */
  addProject(body: {
    name: string;
    root: string;
    kit?: string;
    note?: string;
    max_depth?: number | string;
  }): Promise<{ ok: boolean; project: Project; home?: string } & Project> {
    return this.request("POST", "/api/projects/add", { body });
  }

  queue(projectId: string, opts?: { mutate?: boolean }): Promise<Queue> {
    const query: Record<string, string | undefined> = { project: projectId };
    if (opts?.mutate === false) query.mutate = "0";
    return this.request("GET", "/api/queue", { query });
  }

  /** Bookmark ruling only — does not commit project changes. */
  approve(projectId: string, entryId: string | number): Promise<{ ok: boolean; founding?: boolean }> {
    return this.request("POST", "/api/approve", {
      body: { project: projectId, id: entryId },
    });
  }

  /** User/agent feedback on an entry — send-back note, not approve. Empty text clears. */
  comment(
    projectId: string,
    entryId: string | number,
    text: string,
  ): Promise<{ ok: boolean }> {
    return this.request("POST", "/api/comment", {
      body: { project: projectId, id: entryId, text },
    });
  }

  /** Commit pass for the sitting — NDJSON stream, distinct from approve. */
  sweep(
    projectId: string,
    opts?: {
      onEvent?: (ev: StreamEvent) => void;
      thrust?: string;
      model?: string;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId };
    if (opts?.thrust) body.thrust = opts.thrust;
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/sweep", body, opts?.onEvent, opts?.signal);
  }

  /**
   * Rewrite brief + ask on the current queue only (cold re-entry standard).
   * Does not archive, restock, or close the sitting — NDJSON stream.
   */
  refreshBriefs(
    projectId: string,
    opts?: {
      onEvent?: (ev: StreamEvent) => void;
      model?: string;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId };
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/refresh-briefs", body, opts?.onEvent, opts?.signal);
  }

  /** Freeform curator chat turn — NDJSON stream. */
  chat(
    projectId: string,
    message: string,
    opts?: {
      entryId?: string | number;
      model?: string;
      onEvent?: (ev: StreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId, message };
    if (opts?.entryId != null) body.id = opts.entryId;
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/chat", body, opts?.onEvent, opts?.signal);
  }

  chatlog(projectId: string): Promise<{ messages: ChatMessage[] }> {
    return this.request("GET", "/api/chatlog", { query: { project: projectId } });
  }

  saveChatlog(projectId: string, messages: ChatMessage[]): Promise<{ ok: boolean; count: number }> {
    return this.request("POST", "/api/chatlog", {
      body: { project: projectId, messages },
    });
  }

  file(projectId: string, path: string): Promise<{ path: string; content: string }> {
    return this.request("GET", "/api/file", {
      query: { project: projectId, path },
    });
  }

  /**
   * Write content through core (lineage-aware). Prefer for desk-tracked saves;
   * VS Code already writes to disk — call this after editor save to log user lineage.
   */
  save(
    path: string,
    content: string,
    projectId?: string,
  ): Promise<{ ok: boolean }> {
    const body: Record<string, unknown> = { path, content };
    if (projectId) body.project = projectId;
    return this.request("POST", "/api/save", { body });
  }

  diffstat(
    projectId: string,
    entryId: string | number,
  ): Promise<{ stat: DiffStat; diff: DiffStat }> {
    return this.request("GET", "/api/diffstat", {
      query: { project: projectId, id: String(entryId) },
    });
  }

  diff(
    projectId: string,
    entryId: string | number,
  ): Promise<{ text: string; diff: string }> {
    return this.request("GET", "/api/diff", {
      query: { project: projectId, id: String(entryId) },
    });
  }

  /** Founding status for a project desk. */
  interviewStatus(
    projectId: string,
    opts?: { mutate?: boolean },
  ): Promise<{
    status: string;
    has_session?: boolean;
    has_entries?: boolean;
    entry_count?: number;
    has_proposal?: boolean;
    proposal_path?: string;
  }> {
    const query: Record<string, string | undefined> = { project: projectId };
    if (opts?.mutate === false) query.mutate = "0";
    return this.request("GET", "/api/interview", { query });
  }

  /** Founding interview turn — NDJSON stream (read-only survey + conversation). */
  interview(
    projectId: string,
    message: string,
    opts?: {
      model?: string;
      onEvent?: (ev: StreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId, message };
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/interview", body, opts?.onEvent, opts?.signal);
  }

  /** Finish interview → draft DESK-PROPOSAL.md (NDJSON). */
  propose(
    projectId: string,
    opts?: {
      model?: string;
      onEvent?: (ev: StreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId };
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/propose", body, opts?.onEvent, opts?.signal);
  }

  /** After proposal approve — curator digests + files first content batch (NDJSON). */
  found(
    projectId: string,
    opts?: {
      model?: string;
      onEvent?: (ev: StreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId };
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/found", body, opts?.onEvent, opts?.signal);
  }

  /**
   * Compact the project curator session (summarize-and-continue in place).
   * NDJSON; no-op stream if there is no live session_id yet.
   */
  compact(
    projectId: string,
    opts?: {
      model?: string;
      onEvent?: (ev: StreamEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = { project: projectId };
    if (opts?.model) body.model = opts.model;
    return this.postNdjsonStream("/api/compact", body, opts?.onEvent, opts?.signal);
  }

  /** Drop the project session id — next turn starts a fresh curator thread. */
  clearSession(projectId: string): Promise<{ ok?: boolean }> {
    return this.request("POST", "/api/clear-session", {
      body: { project: projectId },
    });
  }

  getSettings(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/settings");
  }

  /** Deep-merge patch into core settings.json (curator / agents / …). */
  patchSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/settings", { body: patch });
  }

  /**
   * Desk model menu catalog — visible options + active chat model.
   * See GET /api/curator/catalog in kettle-core/API.md.
   */
  curatorCatalog(): Promise<{
    visible?: {
      id: string;
      provider: string;
      label?: string;
      ready?: boolean;
      forced?: boolean;
    }[];
    active?: {
      provider?: string;
      models?: Record<string, string>;
      chat?: string;
    };
    models?: { id: string; provider: string; label?: string }[];
  }> {
    return this.request("GET", "/api/curator/catalog");
  }

  /**
   * Atomic curator selection (desk model pill / editor settings).
   * POST /api/curator — preferred over patching settings by hand.
   */
  setCuratorSelection(opts: {
    model?: string;
    provider?: string;
    task?: string;
    effort?: string;
    command?: string;
    models?: Record<string, string>;
  }): Promise<{
    ok?: boolean;
    active?: { provider?: string; models?: Record<string, string>; chat?: string };
  }> {
    const body: Record<string, unknown> = {};
    if (opts.model) body.model = opts.model;
    if (opts.provider) body.provider = opts.provider;
    if (opts.task) body.task = opts.task;
    if (opts.effort) body.effort = opts.effort;
    if (opts.command) body.command = opts.command;
    if (opts.models) body.models = opts.models;
    return this.request("POST", "/api/curator", { body });
  }

  /** Convenience: set one task model (chat or setup). */
  setCuratorModel(
    model: string,
    opts?: { provider?: string; task?: string; effort?: string },
  ): Promise<{
    ok?: boolean;
    active?: { provider?: string; models?: Record<string, string>; chat?: string };
  }> {
    return this.setCuratorSelection({
      model,
      provider: opts?.provider,
      task: opts?.task || "chat",
      effort: opts?.effort,
    });
  }
}
