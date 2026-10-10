/**
 * Kettle Desk — Secondary Side Bar webview (the sitting surface).
 *
 * ## Layout (top → bottom)
 * 1. **Header** — project selector + settings gear, then entry path.
 *    Path click opens the file. Status/urgency/version chrome stays out of the panel.
 * 2. **Brief pane** — curator ask + brief for the selected queue entry
 *    (no "Brief" title; small info control explains the pane).
 * 3. **Ritual actions** — decision-first **Approve · Comment · Not this · Finish batch**
 *    (side-agnostic; left-aligned, gap collapses as the panel narrows). Every label and
 *    hint comes from core's catalog via ritualParity.ritualControls. Unfounded desks use
 *    the host toast / command palette to begin interview.
 * 4. **Comment drawer** — opens under the ritual bar into the chat area (POST /api/comment).
 * 5. **Stream** — curator chat / sweep NDJSON (or founding fixed pane).
 * 6. **Finish batch drawer** — under ritual bar (like Comment); optional steer, then
 *    Finish batch (a 3-second Undo when kettle.confirmSweep is off).
 * 7. **Composer** — chat only (Enter to send).
 *
 * ## Ritual vocabulary (core, not host Accept Diff). On screen: catalog words only.
 * - **Approve** = bookmark a ruling (`/api/approve`) — does not apply or commit.
 * - **Comment** = send-back note on the entry (`/api/comment`).
 * - **Not this** = set the entry aside (`/api/set-aside`); **Bring back** undoes it.
 * - **Finish batch** = the sweep (`/api/sweep`), optional thrust steer. "Sweep" stays
 *   an identifier; it never reaches the screen.
 *
 * HTML is set once; updates go through postMessage so composer state survives
 * streaming reflows. Host deps in `DeskPanelDeps` own HTTP and VS Code chrome.
 */
import * as vscode from "vscode";
import { activityLabelForEvent } from "./activity";
import type { QueueEntry, StreamEvent } from "./api";
import {
  projectSummarySentence,
  stripMarkdownToPlain,
} from "./briefText";
import {
  looksLikeConfirmCard,
  parseConfirmCard,
  sanitizeInterviewDisplay,
  serializeConfirmCard,
  type ConfirmCard,
  type ConfirmSection,
} from "./confirmCard";
import { BUILD_ID } from "./debug";
import {
  entryDisplayPath,
  isApprovedEntry,
  isHandledEntry,
  isSetAsideEntry,
} from "./project";
import { ritualDampenForZoomLevel } from "./ritualZoom";
import {
  chatModeForPhase,
  deskStatusLine,
  isProposalEntry,
  ritualControls,
} from "./ritualParity";
import * as state from "./state";
import { UI_COPY, uiCopy, uiState } from "./uiCopy";

/** Shown in Desk header — same source as debug.BUILD_ID (package.json version). */
const DESK_UI_BUILD = BUILD_ID;

// Re-export for callers that already import from deskPanel.
export { ritualDampenForZoomLevel } from "./ritualZoom";
export { projectSummarySentence, stripMarkdownToPlain } from "./briefText";

export type DeskPanelDeps = {
  approve: (entry: QueueEntry) => Promise<void>;
  comment: (entry: QueueEntry, text: string) => Promise<void>;
  /** Not this / Bring back (POST /api/set-aside). One action, no prompt. */
  setAside: (entry: QueueEntry, undo: boolean) => Promise<void>;
  /** kettle.confirmSweep — off means Finish batch arms a 3-second Undo instead. */
  confirmSweep: () => boolean;
  sweep: (opts?: {
    thrust?: string;
    onEvent?: (ev: StreamEvent) => void;
    signal?: AbortSignal;
  }) => Promise<void>;
  chat: (
    message: string,
    opts?: { onEvent?: (ev: StreamEvent) => void; signal?: AbortSignal },
  ) => Promise<void>;
  /** Founding interview turn (POST /api/interview). */
  interview: (
    message: string,
    opts?: { onEvent?: (ev: StreamEvent) => void; signal?: AbortSignal },
  ) => Promise<void>;
  /** Finish interview → DESK-PROPOSAL (POST /api/propose). */
  propose: (opts?: {
    onEvent?: (ev: StreamEvent) => void;
    signal?: AbortSignal;
  }) => Promise<void>;
  /** After propose: open DESK-PROPOSAL.md in the editor (host owns focus). */
  openDraftedProposal: () => Promise<void>;
  /** Compact project session (POST /api/compact) — summarize-and-continue. */
  compact: (opts?: {
    onEvent?: (ev: StreamEvent) => void;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  openSettings: () => void;
  /** Open the selected entry in the editor (path click / jump). */
  openEntry: (entry: QueueEntry) => Promise<void>;
  /** Refresh +added/−removed vs desk snapshot (diff badge click). */
  refreshDiff: (entry: QueueEntry) => Promise<QueueEntry>;
  jumpToActive: () => Promise<void>;
  /** Registered projects for the in-Desk dropdown. */
  listProjects: () => Promise<
    { id: string; name: string; root: string; matches: boolean }[]
  >;
  /**
   * Bind this window to a project. With `projectId`, pick directly;
   * without, open the host QuickPick (command palette / empty-state fallback).
   */
  selectProject: (projectId?: string) => Promise<void>;
  /**
   * Register a new desk: host folder browser → POST /api/projects/add → bind
   * → founding interview when unfounded. Not limited to already-registered roots.
   */
  registerProject: () => Promise<void>;
  /** Visible desk models + active chat id (GET /api/curator/catalog). */
  listModels: () => Promise<{
    models: { id: string; label: string; provider: string }[];
    activeId: string;
  }>;
  /** Set chat model (POST /api/curator). */
  setChatModel: (modelId: string, provider?: string) => Promise<void>;
  /**
   * Expand `.kettle` in the host Explorer (folder twisty only — no file
   * selection) so founding writes are visible while streams run.
   */
  revealDeskFolder: (opts?: { path?: string; force?: boolean }) => Promise<void>;
};

type StreamLine =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; streaming?: boolean }
  | {
      kind: "tool";
      text: string;
      path?: string;
      /** Project-root-relative (or shortened) path for display. */
      displayPath?: string;
    }
  | { kind: "sys"; text: string; id?: string }
  | { kind: "error"; text: string }
  | { kind: "confirm"; card: ConfirmCard; raw: string };

/** Middle-ellipsis for long paths so tool rows stay one clean line. */
function ellipsizeMiddle(s: string, max = 52): string {
  if (!s || s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  const tail = keep - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Normalize a tool stream event into a short name + optional path.
 * Core often sends tool name in `s`/`tool` and absolute path in `path`;
 * sometimes the path is also baked into `s` — strip so we don't double-print.
 */
function formatToolEvent(
  ev: StreamEvent,
  projectRoot: string | undefined,
): { name: string; path?: string; displayPath?: string } {
  const rawTool = String(ev.tool || "").trim();
  const rawS = String(ev.s || "").trim();
  let pathStr = ev.path != null && String(ev.path).trim() ? String(ev.path).trim() : "";

  // Prefer explicit tool name; else first token/line of s if it isn't a path.
  let name = rawTool;
  if (!name && rawS) {
    const firstLine = rawS.split(/\n/)[0].trim();
    if (!firstLine.startsWith("/") && !/^[A-Za-z]:\\/.test(firstLine)) {
      name = firstLine.split(/\s+/)[0] || firstLine;
    }
  }
  if (!name) name = "tool";

  // Pull a path out of s when path field is empty.
  if (!pathStr && rawS) {
    const m = rawS.match(/(?:^|\s)(\/[^\s]+|[A-Za-z]:\\[^\s]+)/);
    if (m) pathStr = m[1];
  }

  // If s is "Read /abs/path", keep name as Read only.
  if (pathStr && rawS.includes(pathStr)) {
    const stripped = rawS.replace(pathStr, "").trim();
    if (stripped && !rawTool) {
      name = stripped.split(/\s+/)[0] || name;
    }
  }

  // Capitalize common lowercase tool ids lightly
  if (name === name.toLowerCase() && name.length <= 24) {
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }

  let displayPath: string | undefined;
  if (pathStr) {
    displayPath = projectRoot
      ? entryDisplayPath(pathStr, projectRoot)
      : pathStr.replace(/^\/Users\/[^/]+/, "~");
    displayPath = ellipsizeMiddle(displayPath, 56);
  }

  return { name, path: pathStr || undefined, displayPath };
}

export class DeskPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kettle.deskPanel";

  private view: vscode.WebviewView | undefined;
  private streamLines: StreamLine[] = [];
  private streaming = false;
  private abort: AbortController | undefined;
  private unsub: (() => void) | undefined;
  private ready = false;
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Live activity strip label (tool name / thinking… / working…). */
  private activityLabel = "";
  /**
   * True after the user confirms the interview card. Stops fixed-pane chrome and
   * top-pin so agent activity / text stack below the card in normal stream flow.
   */
  private cardSubmitted = false;
  /** Freeze stream viewport at top during founding interview kickoff. */
  private interviewFreeze = false;
  /** Last dampen sent to the webview (window.zoomLevel counter-scale). */
  private lastRitualDampen = 1;
  /** Cached project rows for the in-Desk dropdown. */
  private projects: {
    id: string;
    name: string;
    root: string;
    matches: boolean;
  }[] = [];
  /** Cached chat models for the in-Desk model pill. */
  private models: { id: string; label: string; provider: string }[] = [];
  private activeModelId = "";

  constructor(private readonly deps: DeskPanelDeps) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.ready = false;
    webviewView.webview.html = shellHtml();

    this.unsub = state.subscribe(() => this.pushState());

    webviewView.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const type = String(msg.type || "");
      const entry = state.getLastEntry();
      try {
        switch (type) {
          case "ready":
            this.ready = true;
            await this.refreshProjects();
            await this.refreshModels();
            this.pushState();
            this.pushStream(true);
            this.pushRitualZoom();
            break;
          case "approve":
            if (entry) {
              await this.deps.approve(entry);
              // approve() owns the one proposal → /api/found orchestration path;
              // host-driven events re-enter through runHostStream().
            }
            break;
          case "comment": {
            if (!entry) return;
            const text = String(msg.text ?? "");
            await this.deps.comment(entry, text);
            this.pushSys(text.trim() ? "Comment saved." : "Comment cleared.");
            this.pushStream(true);
            break;
          }
          case "notThis": {
            // One action, no prompt: Not this on a pending file, Bring back on a
            // set-aside one. The host owns the call and surfaces core's refusal.
            if (!entry || isProposalEntry(entry)) return;
            await this.deps.setAside(entry, isSetAsideEntry(entry));
            break;
          }
          case "sweep": {
            const thrust = String(msg.thrust ?? "").trim() || undefined;
            try {
              await this.runStream("sweep", () =>
                this.deps.sweep({
                  thrust,
                  onEvent: (ev) => this.onStreamEvent(ev),
                  signal: this.abort?.signal,
                }),
              );
              // Success — drop steer draft so the next sweep starts clean.
              this.post({ type: "sweepDone", ok: true });
            } catch (e) {
              // Failure — keep draft and reopen steer drawer. Do not rethrow
              // (would double-fire with the outer message catch).
              const err = e instanceof Error ? e.message : String(e);
              if ((e as { name?: string })?.name !== "AbortError") {
                const last = this.streamLines[this.streamLines.length - 1];
                const already =
                  last?.kind === "error" && String(last.text || "") === err;
                if (!already) {
                  this.pushError(err);
                  this.pushStream(true);
                }
              }
              this.post({
                type: "sweepDone",
                ok: false,
                thrust: thrust || "",
                error: err,
              });
            }
            break;
          }
          case "chat": {
            const text = String(msg.text ?? "").trim();
            if (!text) return;
            // Slash commands (also intercepted in webview sendChat).
            if (/^\/compact\b/i.test(text) || /^compact$/i.test(text)) {
              this.pushUser(text);
              this.pushStream(true);
              this.pushSys("— compacting the working session —");
              this.pushStream(true);
              try {
                let compacted = false;
                await this.runStream("compact", () =>
                  this.deps
                    .compact({
                      onEvent: (ev) => this.onStreamEvent(ev),
                      signal: this.abort?.signal,
                    })
                    .then((didCompact) => {
                      compacted = didCompact;
                    }),
                );
                this.pushSys(
                  compacted
                    ? "context compacted — the thread continues, summarized"
                    : "no active session — nothing to compact",
                );
                this.pushStream(true);
              } catch (e) {
                if ((e as { name?: string })?.name !== "AbortError") {
                  this.pushSys(
                    `compact failed: ${e instanceof Error ? e.message : String(e)}`,
                  );
                  this.pushStream(true);
                }
              }
              break;
            }
            this.pushUser(text);
            this.pushStream(true);
            const mode = chatModeForPhase(state.getFoundingPhase());
            await this.runStream(mode, () =>
              mode === "interview"
                ? this.deps.interview(text, {
                    onEvent: (ev) => this.onStreamEvent(ev),
                    signal: this.abort?.signal,
                  })
                : this.deps.chat(text, {
                    onEvent: (ev) => this.onStreamEvent(ev),
                    signal: this.abort?.signal,
                  }),
            );
            break;
          }
          case "cancel":
            this.abort?.abort();
            this.pushSys("Cancelled.");
            this.streaming = false;
            this.pushStream(true);
            this.post({ type: "streaming", streaming: false });
            break;

          case "compact": {
            this.pushSys("— compacting the working session —");
            this.pushStream(true);
            try {
              let compacted = false;
              await this.runStream("compact", () =>
                this.deps
                  .compact({
                    onEvent: (ev) => this.onStreamEvent(ev),
                    signal: this.abort?.signal,
                  })
                  .then((didCompact) => {
                    compacted = didCompact;
                  }),
              );
              this.pushSys(
                compacted
                  ? "context compacted — the thread continues, summarized"
                  : "no active session — nothing to compact",
              );
              this.pushStream(true);
            } catch (e) {
              if ((e as { name?: string })?.name !== "AbortError") {
                this.pushSys(
                  `compact failed: ${e instanceof Error ? e.message : String(e)}`,
                );
                this.pushStream(true);
              }
            }
            break;
          }

          case "confirmCard": {
            const sections = msg.sections as ConfirmSection[] | undefined;
            if (!sections?.length) return;
            const card: ConfirmCard = { preamble: "", sections, epilogue: "" };
            const text = serializeConfirmCard(card);
            // Leave the fixed founding pane; clear the interview card from the stream
            // (ticks still go to the API — they are visual clutter once submitted).
            this.cardSubmitted = true;
            this.interviewFreeze = false;
            this.streamLines = this.streamLines.filter(
              (l) =>
                l.kind !== "confirm" &&
                !(l.kind === "user" && looksLikeConfirmCard(l.text || "")) &&
                !(l.kind === "agent" && looksLikeConfirmCard(l.text || "")),
            );
            // Drop the kickoff banner too — drafting is the new focus.
            this.streamLines = this.streamLines.filter(
              (l) => !(l.kind === "sys" && l.id === "interview-start"),
            );
            this.streamLines.push({
              kind: "sys",
              text: "Answers sent — the agent is writing the proposal…",
              id: "proposal-draft",
            });
            this.post({
              type: "foundingView",
              phase: "confirmed",
              status: "Drafting Proposal…",
              detail: "Working from Your Answers…",
              build: DESK_UI_BUILD,
            });
            this.pushStream(true);
            // Explorer: expand `.kettle` so the user can watch files appear
            // while propose/found streams (process can take a while).
            // force: bypass throttle; await so Cursor focuses Explorer before stream noise.
            try {
              await this.deps.revealDeskFolder({ force: true });
            } catch {
              /* host reveal is best-effort */
            }
            // Interview turn carries ticks into the session (not shown as a user bubble).
            await this.runStream("interview", () =>
              this.deps.interview(text, {
                onEvent: (ev) => this.onStreamEvent(ev),
                signal: this.abort?.signal,
              }),
            );
            // Always run propose after confirm when still founding — do not rely only
            // on phase (client can lag the server). openDraftedProposal is also
            // called from host propose(); call again here so Cursor gets a second
            // focus pass after the webview message loop.
            const phase = state.getFoundingPhase();
            if (phase === "interviewing" || phase === "proposing" || phase === "none") {
              if (phase !== "proposing") {
                await this.runStream("propose", () =>
                  this.deps.propose({
                    onEvent: (ev) => this.onStreamEvent(ev),
                    signal: this.abort?.signal,
                  }),
                );
              }
            }
            try {
              await this.deps.openDraftedProposal();
            } catch {
              /* host logs */
            }
            break;
          }
          case "settings":
            this.deps.openSettings();
            break;
          case "openEntry":
            if (entry) await this.deps.openEntry(entry);
            break;
          case "jumpActive":
            await this.deps.jumpToActive();
            break;
          case "refreshDiff":
            if (entry) {
              const fresh = await this.deps.refreshDiff(entry);
              state.setLastEntry(fresh);
            }
            break;
          case "selectProject": {
            const pid =
              msg.projectId != null && String(msg.projectId).trim()
                ? String(msg.projectId).trim()
                : undefined;
            await this.deps.selectProject(pid);
            await this.refreshProjects();
            this.pushState();
            break;
          }
          case "registerProject":
            await this.deps.registerProject();
            await this.refreshProjects();
            this.pushState();
            break;
          case "refreshProjects":
            await this.refreshProjects();
            this.pushState();
            break;
          case "refreshModels":
            await this.refreshModels();
            this.pushState();
            break;
          case "setChatModel": {
            const modelId = String(msg.modelId || "").trim();
            const provider = msg.provider != null ? String(msg.provider) : undefined;
            if (modelId) {
              await this.deps.setChatModel(modelId, provider);
              await this.refreshModels();
              this.pushState();
            }
            break;
          }
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        this.pushError(m);
        this.streaming = false;
        this.pushStream(true);
        this.post({ type: "streaming", streaming: false });
      }
    });

    webviewView.onDidDispose(() => {
      this.unsub?.();
      this.unsub = undefined;
      this.view = undefined;
      this.ready = false;
    });
  }

  refresh(): void {
    void Promise.all([this.refreshProjects(), this.refreshModels()]).then(() =>
      this.pushState(),
    );
  }

  /** Re-fetch registered projects for the Desk dropdown. */
  async refreshProjects(): Promise<void> {
    try {
      this.projects = await this.deps.listProjects();
    } catch {
      this.projects = [];
    }
  }

  /** Re-fetch visible chat models + active id for the model pill. */
  async refreshModels(): Promise<void> {
    try {
      const r = await this.deps.listModels();
      this.models = r.models;
      this.activeModelId = r.activeId;
    } catch {
      this.models = [];
      this.activeModelId = "";
    }
  }

  /** Re-read window.zoomLevel and dampen ritual button chrome (safe to call often). */
  pushRitualZoom(): void {
    const z =
      vscode.workspace.getConfiguration("window").get<number>("zoomLevel") ?? 0;
    const dampen = ritualDampenForZoomLevel(z);
    this.lastRitualDampen = dampen;
    this.post({ type: "ritualZoom", dampen, zoomLevel: z });
  }

  clearStream(): void {
    this.streamLines = [];
    this.cardSubmitted = false;
    this.pushStream(true);
  }

  /** Host: open the fixed founding pane (no scrolling stream of raw GFM). */
  startFoundingKickoff(): void {
    this.interviewFreeze = true;
    this.cardSubmitted = false;
    this.streamLines = [];
    this.foundingAgentAcc = "";
    this.pushState();
    this.post({
      type: "foundingView",
      phase: "surveying",
      status: "Beginning Interview…",
      detail: "Surveying the Project…",
      build: DESK_UI_BUILD,
    });
  }

  endFoundingFreeze(): void {
    this.interviewFreeze = false;
  }

  private foundingAgentAcc = "";

  /** Host runs the kickoff interview; agent text is buffered off-screen until card-ready. */
  async runFoundingInterview(message: string): Promise<void> {
    this.foundingAgentAcc = "";
    this.interviewFreeze = true;
    this.abort = new AbortController();
    this.streaming = true;
    this.post({ type: "streaming", streaming: true });
    this.post({
      type: "foundingView",
      phase: "surveying",
      status: "Beginning Interview…",
      detail: "Surveying the Project…",
      build: DESK_UI_BUILD,
    });
    try {
      await this.deps.interview(message, {
        onEvent: (ev) => this.onFoundingStreamEvent(ev),
        signal: this.abort.signal,
      });
      this.finishFoundingBuffer();
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        this.post({
          type: "foundingView",
          phase: "error",
          status: "Beginning Interview…",
          detail: "Cancelled.",
          build: DESK_UI_BUILD,
        });
      } else {
        throw e;
      }
    } finally {
      this.streaming = false;
      this.abort = undefined;
      this.post({ type: "streaming", streaming: false });
      this.pushState();
    }
  }

  private onFoundingStreamEvent(ev: StreamEvent): void {
    if (ev.t === "text" && ev.s) {
      this.foundingAgentAcc += ev.s;
      const preparing = looksLikeConfirmCard(this.foundingAgentAcc);
      // Buffer only — never paint raw GFM. Card publishes when the stream finishes.
      this.post({
        type: "foundingView",
        phase: preparing ? "preparing" : "surveying",
        status: "Beginning Interview…",
        detail: preparing ? "Preparing Interview Questions…" : "Surveying the Project…",
        build: DESK_UI_BUILD,
      });
      return;
    }
    if (ev.t === "error" && ev.s) {
      this.post({
        type: "foundingView",
        phase: "error",
        status: "Beginning Interview…",
        detail: String(ev.s),
        build: DESK_UI_BUILD,
      });
    }
  }

  private finishFoundingBuffer(): void {
    const raw = this.foundingAgentAcc;
    if (looksLikeConfirmCard(raw)) {
      const card = parseConfirmCard(raw);
      if (card.sections.length) {
        this.publishFoundingCard(card, raw);
        return;
      }
    }
    // Could not parse — never dump raw GFM; show sanitized short notice
    this.interviewFreeze = false;
    this.streamLines = [
      { kind: "sys", text: "Beginning Interview…", id: "interview-start" },
      {
        kind: "agent",
        text: sanitizeInterviewDisplay(raw).slice(0, 2000) || "(no interview text)",
      },
    ];
    this.pushStream(true);
    this.post({
      type: "foundingView",
      phase: "fallback",
      status: "Beginning Interview…",
      detail: "Could not build the interactive card — sanitized text is in the stream below.",
      build: DESK_UI_BUILD,
    });
  }

  private publishFoundingCard(card: ConfirmCard, raw: string): void {
    // Strip any leftover id/multi chrome from stems before UI
    for (const s of card.sections) {
      s.stem = s.stem
        .replace(/\s*\[[\w]+\]\s*·\s*(multi|pick one)\s*$/i, "")
        .replace(/\s*\((?:multi-select|single choice)\)\s*$/i, "")
        .trim();
    }
    this.interviewFreeze = false;
    this.cardSubmitted = false;
    this.streamLines = [
      { kind: "sys", text: "Beginning Interview…", id: "interview-start" },
      { kind: "confirm", card, raw },
    ];
    this.post({
      type: "foundingView",
      phase: "card",
      status: "Beginning Interview…",
      detail: "",
      card,
      build: DESK_UI_BUILD,
    });
    this.pushStream(true);
  }

  private post(msg: Record<string, unknown>): void {
    if (!this.view || !this.ready) return;
    void this.view.webview.postMessage(msg);
  }

  private pushState(): void {
    if (!this.view || !this.ready) return;
    const entry = state.getLastEntry();
    const st = state.getState();
    const interviewing = state.isInterviewing();
    const proposing = state.isProposing();
    // "founding" = interview-only chrome (hide ritual). Proposing keeps Approve.
    const founding = interviewing;
    const projMeta = this.projects.find((p) => p.id === st.projectId);
    // Status line from the catalog's states (line register); the project's name
    // when no state applies. Never a sentence of our own for a catalog state.
    const statusLine = deskStatusLine({
      connected: st.connected,
      hasProject: !!st.projectId,
      projectName: (projMeta?.name || st.projectId || "").trim(),
      phase: st.foundingPhase,
      activity: state.getDeskActivity(),
      hasEntry: !!entry,
    });
    const approved = entry ? isApprovedEntry(entry) : false;
    const setAside = entry ? isSetAsideEntry(entry) : false;
    const ritual = ritualControls({
      phase: st.foundingPhase,
      hasProject: !!st.projectId,
      hasEntry: !!entry,
      approved,
      streaming: this.streaming,
      setAside,
      isProposal: isProposalEntry(entry),
    });
    const projectSummary =
      st.projectId && !entry && !interviewing && !proposing
        ? projectSummarySentence(
            st.projectRoot || projMeta?.root,
            (projMeta?.name || st.projectId || "").trim(),
          )
        : "";
    this.post({
      type: "state",
      projectId: st.projectId ?? null,
      projects: this.projects,
      models: this.models,
      activeModelId: this.activeModelId || null,
      connected: st.connected,
      statusText: st.statusText,
      statusLine,
      streaming: this.streaming,
      foundingPhase: st.foundingPhase,
      founding,
      proposing,
      projectSummary,
      noEntryBriefBody: UI_COPY.noEntryBriefBody,
      ritual,
      confirmSweep: this.deps.confirmSweep(),
      interviewFreeze: this.interviewFreeze,
      chatPlaceholder: proposing
        ? UI_COPY.chatPlaceholderProposing
        : interviewing
          ? UI_COPY.chatPlaceholderFounding
          : UI_COPY.chatPlaceholder,
      build: DESK_UI_BUILD,
      entry: entry
        ? {
            id: entry.id,
            path: entry.path,
            // Relative to project root when possible (header shows this).
            displayPath: st.projectRoot
              ? entryDisplayPath(entry.path, st.projectRoot)
              : entry.path,
            status: entry.status || "pending",
            approved,
            setAside,
            handled: isHandledEntry(entry),
            urgency: entry.urgency || "",
            // Takeaway line (formerly shown as "ask") — plain text, no raw GFM.
            takeaway: stripMarkdownToPlain(entry.ask || ""),
            ask: entry.ask || "",
            brief: entry.brief || entry.ask || "",
            briefHtml: renderMarkdown(entry.brief || entry.ask || "(no summary yet)"),
            comment: entry.comment || "",
            diff: entry.diff ?? null,
          }
        : null,
    });
  }

  private pushStream(full: boolean): void {
    if (!this.view || !this.ready) return;
    // Mid-stream upgrade: as soon as the agent text is a full card, swap it in.
    // After the user confirms the card, leave it alone — later agent text is real work.
    if (
      (this.interviewFreeze || state.isInterviewing()) &&
      !this.cardSubmitted
    ) {
      this.maybeUpgradeLastAgentToCard();
    }
    // Interview freeze chrome only — proposing/chat must show tools + live text.
    const interviewing = state.isInterviewing();
    const hasConfirm = this.streamLines.some((l) => l.kind === "confirm");
    // Pin only while the fixed kickoff / unsubmitted card is the focus. After
    // confirm, follow the stream tail so thinking / draft work push the card up.
    const pinTop =
      this.interviewFreeze ||
      (interviewing && !this.cardSubmitted && (!hasConfirm || this.interviewFreeze));
    this.post({
      type: "stream",
      full,
      streaming: this.streaming,
      freeze:
        this.interviewFreeze ||
        (interviewing && !hasConfirm && !this.cardSubmitted),
      pinTop,
      cardSubmitted: this.cardSubmitted,
      lines: this.streamLines
        .map((line) => {
          if (line.kind === "confirm") {
            return {
              kind: "confirm",
              card: line.card,
              raw: line.raw,
              submitted: this.cardSubmitted,
            };
          }
          if (line.kind === "agent" || line.kind === "user") {
            const streaming = line.kind === "agent" && !!line.streaming;
            // Interview kickoff only: never show raw GFM checklist while the card
            // is still forming. After confirm, stream real agent text.
            if (interviewing && line.kind === "agent" && !this.cardSubmitted) {
              if (this.interviewFreeze || streaming) {
                const pending = looksLikeConfirmCard(line.text || "")
                  ? "Preparing Interview Questions…"
                  : "Surveying the Project…";
                return {
                  kind: "agent",
                  text: pending,
                  streaming: true,
                  html: escapeHtml(pending),
                };
              }
              return {
                ...line,
                html: renderMarkdown(sanitizeInterviewDisplay(line.text || "")),
              };
            }
            // Skip empty agent stubs (was rendering as blank "…" bubbles between tools).
            if (line.kind === "agent" && !(line.text || "").trim()) {
              return null;
            }
            return { ...line, html: renderMarkdown(line.text || "") };
          }
          if (line.kind === "tool") {
            const name = escapeHtml(line.text || "tool");
            const shown = line.displayPath || line.path;
            const pathHtml = shown
              ? `<span class="toolpath" title="${escapeHtml(line.path || shown)}">${escapeHtml(shown)}</span>`
              : "";
            return {
              kind: "tool",
              text: line.text,
              path: line.path,
              displayPath: line.displayPath,
              html: `<span class="tool-name">${name}</span>${pathHtml}`,
            };
          }
          return {
            kind: line.kind,
            text: line.text,
            id: line.kind === "sys" ? line.id : undefined,
            html: escapeHtml(line.text || ""),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null),
    });
  }

  /**
   * Host-driven stream (e.g. proposal approve → /api/found) with the same
   * stream chrome as chat/sweep.
   */
  async runHostStream(
    label: string,
    runner: (onEvent: (ev: StreamEvent) => void) => Promise<void>,
  ): Promise<void> {
    await this.runStream(label, () => runner((ev) => this.onStreamEvent(ev)));
  }

  /** Host: append a system line to the Desk stream (compact notices, etc.). */
  noteSys(text: string): void {
    this.pushSys(text);
    this.pushStream(true);
  }

  private setActivity(label: string): void {
    this.activityLabel = (label || "").trim() || "working…";
    this.post({
      type: "activity",
      active: this.streaming,
      label: this.activityLabel,
    });
  }

  private clearActivity(): void {
    this.activityLabel = "";
    this.post({ type: "activity", active: false, label: "" });
  }

  private async runStream(label: string, fn: () => Promise<void>): Promise<void> {
    if (this.streaming) {
      this.pushSys("Already streaming — cancel first.");
      this.pushStream(true);
      return;
    }
    this.abort = new AbortController();
    this.streaming = true;
    // No "— found —" / "— interview —" / "— sweep —" chrome in the stream.
    // The label picks the catalog state a long stream is in (status bar + activity).
    const activity =
      label === "sweep" ? "sweeping" : label === "found" ? "founding" : undefined;
    if (activity) state.setDeskActivity(activity);
    this.streamLines.push({ kind: "agent", text: "", streaming: true });
    this.post({ type: "streaming", streaming: true });
    this.setActivity(activity ? uiState(activity, "line") : "working…");
    this.pushState(); // re-enable lockstep (dim ritual buttons while streaming)
    this.pushStream(true);
    try {
      await fn();
      const last = this.streamLines[this.streamLines.length - 1];
      if (last?.kind === "agent" && last.streaming) {
        last.streaming = false;
        if (!last.text.trim()) this.streamLines.pop();
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        this.pushSys("Stream aborted.");
      } else {
        throw e;
      }
    } finally {
      this.streaming = false;
      this.abort = undefined;
      if (activity && state.getDeskActivity() === activity) state.setDeskActivity("idle");
      this.clearActivity();
      this.maybeUpgradeLastAgentToCard();
      this.post({ type: "streaming", streaming: false });
      this.pushState(); // restore ritual button enablement
      this.pushStream(true);
    }
  }

  /** Upgrade GFM confirmation checklist to an interactive card (mid-stream or at end). */
  private maybeUpgradeLastAgentToCard(): void {
    if (!state.isInterviewing()) return;
    for (let i = this.streamLines.length - 1; i >= 0; i--) {
      const line = this.streamLines[i];
      if (line.kind === "confirm") return; // already upgraded
      if (line.kind !== "agent") continue;
      const raw = line.text || "";
      if (!looksLikeConfirmCard(raw)) continue; // try older agent bubbles
      const card = parseConfirmCard(raw);
      if (!card.sections.length) continue;
      this.streamLines[i] = { kind: "confirm", card, raw };
      // Drop any empty trailing agent stubs after the card
      this.streamLines = this.streamLines.filter(
        (l, idx) => !(idx > i && l.kind === "agent" && !(l.text || "").trim()),
      );
      this.interviewFreeze = false;
      this.post({ type: "freeze", freeze: false });
      return;
    }
  }

  private onStreamEvent(ev: StreamEvent): void {
    // Activity is coarse operational chrome; never display provider reasoning.
    if (ev.t === "activity") {
      this.setActivity(activityLabelForEvent(ev) || "working…");
      return;
    }
    if (ev.t === "text" && ev.s) {
      // Drop empty streaming stubs before appending real text.
      while (this.streamLines.length) {
        const tail = this.streamLines[this.streamLines.length - 1];
        if (tail.kind === "agent" && tail.streaming && !tail.text.trim()) {
          this.streamLines.pop();
          continue;
        }
        break;
      }
      let last = this.streamLines[this.streamLines.length - 1];
      if (!last || last.kind !== "agent" || !last.streaming) {
        last = { kind: "agent", text: "", streaming: true };
        this.streamLines.push(last);
      }
      last.text += ev.s;
      if (this.streaming) this.setActivity("writing…");
      this.scheduleStreamPush();
      return;
    }
    if (ev.t === "tool") {
      const fmt = formatToolEvent(ev, state.getProjectRoot());
      const act = fmt.displayPath
        ? `${fmt.name} ${fmt.displayPath}`
        : fmt.name;
      this.setActivity(act);
      // Do not re-reveal/open files on each tool write — that was yanking the
      // editor to random .kettle JSON. Folder expand happens once on confirm.
      // During founding kickoff freeze, keep tool *rows* out of the stream but
      // still show them on the activity strip (above).
      if (this.interviewFreeze) {
        this.scheduleStreamPush();
        return;
      }
      const last = this.streamLines[this.streamLines.length - 1];
      if (last?.kind === "agent" && last.streaming) {
        if (!last.text.trim()) this.streamLines.pop();
        else last.streaming = false;
      }
      this.streamLines.push({
        kind: "tool",
        text: fmt.name,
        path: fmt.path,
        displayPath: fmt.displayPath,
      });
      // Do not insert an empty agent bubble — wait for real text.
      this.scheduleStreamPush();
      return;
    }
    if (ev.t === "error" && ev.s) {
      this.pushError(String(ev.s));
      this.scheduleStreamPush();
      return;
    }
    if (ev.t === "usage" && typeof ev.context === "number") {
      // One live meter line only — replace prior usage so the stream is not littered.
      const win = typeof ev.window === "number" ? ev.window : undefined;
      const pct = win ? Math.round((ev.context / win) * 100) : undefined;
      if (pct != null || ev.peak != null) {
        const label =
          pct != null
            ? `context ${ev.context.toLocaleString()} / ${win!.toLocaleString()} (${pct}%)`
            : `context ${ev.context.toLocaleString()}`;
        const existing = this.streamLines.findIndex(
          (l) => l.kind === "sys" && l.id === "usage",
        );
        if (existing >= 0) {
          this.streamLines[existing] = { kind: "sys", text: label, id: "usage" };
        } else {
          this.streamLines.push({ kind: "sys", text: label, id: "usage" });
        }
        // Keep the usage meter at the tail (after tools/text so far).
        const u = this.streamLines.find((l) => l.kind === "sys" && l.id === "usage");
        if (u) {
          this.streamLines = this.streamLines.filter(
            (l) => !(l.kind === "sys" && l.id === "usage"),
          );
          this.streamLines.push(u);
        }
        this.scheduleStreamPush();
      }
      return;
    }
    if (ev.t === "done") {
      const last = this.streamLines[this.streamLines.length - 1];
      if (last?.kind === "agent" && last.streaming) {
        last.streaming = false;
        if (!last.text.trim()) this.streamLines.pop();
      }
      // Drop trailing empty agent stubs after the turn ends.
      while (this.streamLines.length) {
        const tail = this.streamLines[this.streamLines.length - 1];
        if (tail.kind === "agent" && !tail.text.trim()) {
          this.streamLines.pop();
          continue;
        }
        break;
      }
      this.scheduleStreamPush();
    }
  }

  private scheduleStreamPush(): void {
    if (this.throttleTimer) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = undefined;
      this.pushStream(true);
    }, 40);
  }

  private pushUser(text: string): void {
    this.streamLines.push({ kind: "user", text });
  }

  private pushSys(text: string): void {
    this.streamLines.push({ kind: "sys", text });
  }

  private pushError(text: string): void {
    this.streamLines.push({ kind: "error", text });
  }
}


function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal GFM-ish markdown → safe HTML for briefs and stream bubbles. */
export function renderMarkdown(src: string): string {
  if (!src.trim()) return '<p class="muted">No summary yet.</p>';
  let s = escapeHtml(src);
  s = s.replace(/```([\s\S]*?)```/g, (_m, code: string) =>
    `<pre class="code"><code>${String(code).trim()}</code></pre>`,
  );
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/gm, "$1<em>$2</em>");
  s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (_m, block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((line: string) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
      .map((i: string) => `<li>${i}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });
  s = s
    .split(/\n{2,}/)
    .map((para) => {
      if (/^<(h[34]|ul|pre)/.test(para.trim())) return para;
      return `<p>${para.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
  return s;
}

export function shellHtml(): string {
  // Icons + CSS + client logic; content filled via postMessage.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  :root {
    --bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground, color-mix(in srgb, var(--fg) 62%, transparent));
    --border: var(--vscode-panel-border, var(--vscode-widget-border, color-mix(in srgb, var(--fg) 18%, transparent)));
    --btn-bg: var(--vscode-button-secondaryBackground, color-mix(in srgb, var(--fg) 10%, transparent));
    --btn-fg: var(--vscode-button-secondaryForeground, var(--fg));
    --btn-pri-bg: var(--vscode-button-background);
    --btn-pri-fg: var(--vscode-button-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, var(--border));
    --font: var(--vscode-font-family);
    --font-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --fs: var(--vscode-font-size, 13px);
    --tint-user: color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 14%, transparent);
    --tint-agent: color-mix(in srgb, var(--fg) 6%, transparent);
    --tint-tool: color-mix(in srgb, var(--vscode-charts-orange, #d4a017) 12%, transparent);
    --tint-error: color-mix(in srgb, var(--vscode-errorForeground, #f44747) 14%, transparent);
    --edge-user: color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 55%, transparent);
    --edge-agent: color-mix(in srgb, var(--fg) 28%, transparent);
    --edge-tool: color-mix(in srgb, var(--vscode-charts-orange, #d4a017) 50%, transparent);
    --edge-error: var(--vscode-errorForeground, #f44747);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    max-height: 100%;
    overflow: hidden; /* only #stream scrolls — never the webview page */
    background: var(--bg); color: var(--fg);
    font-family: var(--font); font-size: var(--fs);
  }
  body {
    display: flex; flex-direction: column;
    height: 100%; min-height: 0; max-height: 100%;
  }
  button, textarea, input { font: inherit; color: inherit; }
  button {
    background: var(--btn-bg); color: var(--btn-fg);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 4px 10px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px;
  }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary {
    background: var(--btn-pri-bg); color: var(--btn-pri-fg); border-color: transparent;
  }
  button.ghost { background: transparent; border-color: transparent; padding: 2px 6px; }
  button.icon { width: 28px; height: 28px; padding: 0; justify-content: center; }
  .icon-svg { width: 14px; height: 14px; display: block; fill: currentColor; }
  /* Ritual bar: partially counter-scales under window.zoomLevel (see ritualZoom). */
  .actions-ritual {
    zoom: var(--ritual-dampen, 1);
  }
  /* Ritual buttons: ~20% smaller than the 12px/28px baseline */
  #btnApprove,
  #btnCommentToggle,
  #btnNotThis,
  #btnSweep {
    font-size: 9.6px;
    font-weight: 500;
    line-height: 1;
    padding: 4.8px 9.6px 4.8px 8px;
    gap: 0;
    min-height: 22px;
    align-items: center;
    justify-content: center;
  }
  #btnApprove { font-weight: 600; }
  /* Fixed icon slot — equal optical weight before the label */
  #btnApprove .btn-ico,
  #btnCommentToggle .btn-ico,
  #btnSweep .btn-ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 11px;
    height: 11px;
    margin-right: 5.5px;
  }
  #btnApprove .btn-ico .icon-svg,
  #btnCommentToggle .btn-ico .icon-svg,
  #btnSweep .btn-ico .icon-svg {
    width: 11px;
    height: 11px;
    max-width: none;
    max-height: none;
    display: block;
  }
  /* Play triangle is optically left-heavy — nudge into the slot center */
  #btnSweep .btn-ico .icon-svg {
    transform: translateX(1px);
  }
  /* Speech bubble sits optically high — slight drop to match the label */
  #btnCommentToggle .btn-ico .icon-svg {
    transform: translateY(1.5px);
  }

  header.top {
    flex: none; display: flex; flex-direction: column; gap: 8px;
    padding: 10px 12px 8px; border-bottom: 1px solid var(--border);
    /* Stack above brief/stream so absolute proj/model menus receive clicks
       (body is overflow:hidden; later flex siblings otherwise paint over the menu). */
    position: relative;
    z-index: 100;
    overflow: visible;
  }
  /* Top chrome: project selector + settings (mirrors core desk / VS Code plugin chrome). */
  header.top .chrome {
    display: flex; align-items: center; gap: 8px; min-width: 0;
    position: relative;
    z-index: 1;
    overflow: visible;
  }
  header.top .meta { min-width: 0; }
  .path {
    font-family: var(--font-mono); font-size: 12px; font-weight: 600;
    word-break: break-all; line-height: 1.35;
    color: var(--vscode-textLink-foreground, var(--fg));
  }
  .path.clickable { cursor: pointer; text-decoration: underline dotted transparent; }
  .path.clickable:hover { text-decoration-color: var(--muted); filter: brightness(1.08); }
  .conn {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: var(--vscode-testing-iconFailed, #f44747);
  }
  .conn.on { background: var(--vscode-testing-iconPassed, #3bb26b); }
  /* Project selector — named pill + roomy in-panel dropdown. */
  .proj-wrap {
    position: relative; flex: 1 1 auto; min-width: 0;
    z-index: 2; /* above path row in header if any */
  }
  .proj-select {
    width: 100%;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 6px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    color: var(--fg); font: inherit; font-size: 12.5px; font-weight: 600;
    cursor: pointer; text-align: left;
  }
  .proj-select:hover,
  .proj-select[aria-expanded="true"] {
    filter: brightness(1.08);
    border-color: color-mix(in srgb, var(--fg) 28%, var(--border));
  }
  .proj-select .proj-label {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .proj-select .chev {
    flex: none; width: 10px; height: 10px; opacity: 0.65;
    transition: transform 0.12s ease;
  }
  .proj-select[aria-expanded="true"] .chev { transform: rotate(180deg); }
  .proj-select.placeholder .proj-label { font-weight: 500; color: var(--muted); }
  /* Model pill — mirrors project select (core desk / VS Code chrome). */
  .model-wrap {
    position: relative; flex: 0 1 auto; min-width: 0; max-width: 42%;
  }
  .model-select {
    width: 100%;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 6px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    color: var(--fg); font: inherit; font-size: 12px; font-weight: 500;
    cursor: pointer; text-align: left;
  }
  .model-select:hover,
  .model-select[aria-expanded="true"] {
    filter: brightness(1.08);
    border-color: color-mix(in srgb, var(--fg) 28%, var(--border));
  }
  .model-select .model-label {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .model-select .chev {
    flex: none; width: 10px; height: 10px; opacity: 0.65;
    transition: transform 0.12s ease;
  }
  .model-select[aria-expanded="true"] .chev { transform: rotate(180deg); }
  .model-select.placeholder .model-label { color: var(--muted); font-weight: 500; }
  .model-menu {
    display: none;
    position: fixed;
    z-index: 10000;
    max-height: min(280px, 50vh); overflow-y: auto;
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--vscode-editorWidget-background,
      var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e)));
    color: var(--vscode-dropdown-foreground, var(--fg));
    box-shadow: 0 8px 24px color-mix(in srgb, #000 45%, transparent);
    padding: 6px 0;
  }
  .model-menu.open { display: block !important; }
  .proj-menu {
    /* Fixed geometry is applied in JS (getBoundingClientRect) so the panel is not
       clipped by body{overflow:hidden} or painted under brief/stream siblings. */
    display: none;
    position: fixed;
    z-index: 10000;
    max-height: min(320px, 55vh); overflow-y: auto; overflow-x: hidden;
    border: 1px solid var(--border); border-radius: 8px;
    /* Opaque so brief text does not show through */
    background: var(--vscode-editorWidget-background,
      var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e)));
    color: var(--vscode-dropdown-foreground, var(--fg));
    box-shadow: 0 8px 24px color-mix(in srgb, #000 45%, transparent);
    padding: 6px 0;
  }
  .proj-menu.open { display: block !important; }
  .proj-opt {
    /* Override global button { align-items: center } so name/path sit left. */
    display: flex; flex-direction: column; align-items: flex-start;
    justify-content: flex-start; gap: 3px;
    width: 100%; padding: 10px 14px; border: 0; background: transparent;
    color: inherit; font: inherit; font-size: 13px; text-align: left;
    cursor: pointer;
  }
  .proj-opt .opt-name,
  .proj-opt .opt-meta {
    width: 100%;
    text-align: left;
  }
  .proj-opt:hover, .proj-opt:focus {
    outline: none;
    background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--fg) 10%, transparent));
  }
  .proj-opt.active {
    background: var(--vscode-list-activeSelectionBackground, color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 28%, transparent));
    color: var(--vscode-list-activeSelectionForeground, var(--fg));
  }
  .proj-opt .opt-name { font-weight: 600; line-height: 1.35; }
  .proj-opt .opt-meta {
    font-size: 11px; line-height: 1.35; opacity: 0.72;
    font-family: var(--font-mono);
    /* Allow long roots to wrap instead of crushing the row */
    white-space: normal; overflow-wrap: anywhere; word-break: break-word;
  }
  .proj-opt.sep {
    margin-top: 4px; padding-top: 10px;
    border-top: 1px solid var(--border); border-radius: 0;
  }
  .proj-opt.empty {
    cursor: default; opacity: 0.75; font-size: 12px; font-weight: 500;
  }
  .proj-opt.empty:hover { background: transparent; }
  /* Settings gear — same chrome height / hover as project & model pills (not ghost/icon). */
  #btnSettings {
    flex: none;
    box-sizing: border-box;
    width: auto;
    height: auto;
    min-width: 0;
    min-height: 0;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    color: var(--fg);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: stretch; /* match row height of neighboring pills */
  }
  #btnSettings:hover:not(:disabled) {
    filter: brightness(1.08);
    border-color: color-mix(in srgb, var(--fg) 28%, var(--border));
    background: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  #btnSettings .icon-svg {
    width: 14px;
    height: 14px;
    display: block;
    fill: currentColor;
  }

  /* Ritual bar: decision-first, centered; gap is 2× prior default, collapses to old min. */
  .actions {
    flex: none; display: flex; flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    container-type: inline-size;
    container-name: ritual;
    /* Four controls since Not this: back to the narrower span so one row holds
       at a default sidebar width (was 8cqi/28px with three). */
    column-gap: clamp(6px, 3%, 16px);
    row-gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  /* Ritual colors: Approve cyan · Comment yellow · Sweep green (shared tint recipe). */
  #btnApprove {
    /* Cyan reads brighter on dark sidebars than muted textLink blue. */
    --ritual-approve: var(--vscode-charts-blue, #18a0fb);
    background: color-mix(in srgb, var(--ritual-approve) 16%, transparent);
    border-color: color-mix(in srgb, var(--ritual-approve) 48%, var(--border));
    color: var(--ritual-approve, #3ecbff);
  }
  #btnApprove:hover:not(:disabled) {
    filter: brightness(1.1);
    background: color-mix(in srgb, var(--ritual-approve) 24%, transparent);
  }
  #btnCommentToggle {
    /* Same recipe as Sweep: theme accent mixed with a deeper base so labels
       hold on light themes and still read on dark (peer set with Approve cyan). */
    --ritual-comment: color-mix(
      in srgb,
      var(--vscode-editorWarning-foreground, #cca700) 42%,
      #9a6b00 58%
    );
    background: color-mix(in srgb, var(--ritual-comment) 16%, transparent);
    border-color: color-mix(in srgb, var(--ritual-comment) 52%, var(--border));
    color: var(--ritual-comment);
  }
  #btnCommentToggle:hover:not(:disabled) {
    filter: brightness(1.08);
    background: color-mix(in srgb, var(--ritual-comment) 24%, transparent);
  }
  /* Not this: a correction, not the action a batch is built around — the least
     emphasis of the four (no tint, no icon, muted label). */
  #btnNotThis {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
    padding: 4.8px 3px;
  }
  #btnNotThis:hover:not(:disabled) {
    filter: none;
    color: var(--fg);
    border-color: var(--border);
  }
  /* Narrow panel: Finish batch takes the catalog's short form (sweepLabel.short,
     "same meaning, fewer words"); narrower still, the buttons tighten. */
  .btn-label-short { display: none; }
  @container ritual (max-width: 359px) {
    #btnSweep .btn-label { display: none; }
    #btnSweep .btn-label-short { display: inline; }
  }
  @container ritual (max-width: 319px) {
    #btnApprove, #btnCommentToggle, #btnSweep { padding-left: 6px; padding-right: 6px; }
    /* Words over icons when space runs out: the label is the instruction. */
    #btnApprove .btn-ico, #btnCommentToggle .btn-ico, #btnSweep .btn-ico { display: none; }
  }
  /* A set-aside file reads as handled: dimmed and italic, like its queue row. */
  body.setaside #path { font-style: italic; opacity: 0.7; }
  #btnSweep {
    /* Deeper/more saturated than testing-iconPassed so label holds on light themes
       without washing out on dark (theme green is often too light on white). */
    --ritual-sweep: color-mix(
      in srgb,
      var(--vscode-testing-iconPassed, #3bb26b) 42%,
      #0b6b38 58%
    );
    background: color-mix(in srgb, var(--ritual-sweep) 16%, transparent);
    border-color: color-mix(in srgb, var(--ritual-sweep) 52%, var(--border));
    color: var(--ritual-sweep);
  }
  #btnSweep:hover:not(:disabled) {
    filter: brightness(1.08);
    background: color-mix(in srgb, var(--ritual-sweep) 24%, transparent);
  }
  /* Run sweep in the steer drawer matches the Sweep ritual button. */
  #btnSweepGo {
    --ritual-sweep: color-mix(
      in srgb,
      var(--vscode-testing-iconPassed, #3bb26b) 42%,
      #0b6b38 58%
    );
    background: color-mix(in srgb, var(--ritual-sweep) 16%, transparent);
    border-color: color-mix(in srgb, var(--ritual-sweep) 52%, var(--border));
    color: var(--ritual-sweep);
    font-size: 9.6px;
    font-weight: 500;
    line-height: 1;
    padding: 4.8px 9.6px 4.8px 8px;
    min-height: 22px;
    align-items: center;
  }
  #btnSweepGo:hover:not(:disabled) {
    filter: brightness(1.08);
    background: color-mix(in srgb, var(--ritual-sweep) 24%, transparent);
  }
  #btnSweepGo .btn-ico {
    display: inline-flex; align-items: center; justify-content: center;
    flex: none; width: 11px; height: 11px; margin-right: 5.5px;
  }
  #btnSweepGo .btn-ico .icon-svg {
    width: 11px; height: 11px; display: block; transform: translateX(1px);
  }
  /* Confirmation off: Finish batch arms for 3 s and reads Undo; a press cancels. */
  #btnSweepGo.arming {
    background: color-mix(in srgb, var(--ritual-sweep) 30%, transparent);
    font-weight: 600;
  }
  #btnSweepGo.arming .btn-ico { display: none; }
  .sweep-body { font-size: 11px; color: var(--muted); margin: 0 0 6px; }
  /* Legacy empty-cta kept in DOM for one-shot host messages; hidden — project pill is the CTA. */
  .empty-cta { display: none !important; }
  /* No project: one control (header pill), one quiet hint (brief). No path / no second button. */
  body.needs-project .meta { display: none; }
  body.needs-project .actions-ritual { display: none; }
  body.needs-project .brief-sec { display: none; }
  .section {
    flex: none; padding: 10px 12px; border-bottom: 1px solid var(--border);
  }
  .section-label {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); font-weight: 600; margin: 0 0 6px;
  }
  /* Brief pane: no title chrome — small info control only. */
  .brief-sec {
    position: relative;
    padding-right: 28px; /* room for the corner info button */
  }
  .brief-info-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--border) 80%, var(--muted));
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    font-style: italic;
    font-family: var(--font);
    line-height: 1;
    justify-content: center;
    z-index: 2;
  }
  .brief-info-btn:hover:not(:disabled),
  .brief-info-btn[aria-expanded="true"] {
    color: var(--fg);
    border-color: color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 45%, var(--border));
    background: color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 12%, var(--bg));
  }
  .brief-info-tip {
    display: none;
    position: absolute;
    top: 30px;
    right: 8px;
    left: 12px;
    z-index: 5;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--vscode-editorWidget-background, var(--bg));
    color: var(--fg);
    box-shadow: 0 4px 14px color-mix(in srgb, #000 22%, transparent);
    font-size: 11.5px;
    font-weight: 400;
    line-height: 1.45;
    text-transform: none;
    letter-spacing: 0;
  }
  .brief-info-tip.open { display: block; }
  .brief-info-tip strong {
    display: block;
    font-size: 11px;
    font-weight: 600;
    margin: 0 0 4px;
    color: var(--fg);
  }
  /* Brief summary sits under the ask — smaller / quieter so the ask leads. */
  .brief { font-size: 13px; line-height: 1.5; color: color-mix(in srgb, var(--fg) 82%, transparent); }
  .brief h3, .brief h4 { font-size: 13px; margin: 0.6em 0 0.25em; font-weight: 600; color: var(--fg); }
  .brief p { margin: 0 0 0.55em; }
  .brief ul { margin: 0.2em 0 0.55em; padding-left: 1.2em; }
  .brief li { margin: 0.15em 0; }
  .brief code {
    font-family: var(--font-mono); font-size: 0.92em;
    background: color-mix(in srgb, var(--fg) 8%, transparent);
    padding: 0 3px; border-radius: 2px;
  }
  .brief pre.code {
    font-family: var(--font-mono); font-size: 11px;
    background: color-mix(in srgb, var(--fg) 6%, transparent);
    padding: 8px; border-radius: 4px; overflow-x: auto;
    border: 1px solid var(--border);
  }
  .muted { color: var(--muted); }
  /* Takeaway quote (curator ask) — larger lead line; not labeled "Ask". */
  .takeaway {
    font-size: 13.5px; font-weight: 600; line-height: 1.4;
    color: var(--fg); margin: 0 0 10px;
    border-left: 3px solid color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 55%, var(--border));
    padding: 2px 0 2px 10px;
  }
  /* Comment / Sweep drawers — under ritual bar, open downward into the chat stream. */
  .comment-box,
  .sweep-panel {
    display: none; flex: none;
    border-bottom: 1px solid var(--border);
  }
  .comment-box {
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 6%, transparent);
  }
  .sweep-panel {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3bb26b) 6%, transparent);
  }
  body.comment-open .comment-box { display: block; }
  body.sweep-open .sweep-panel { display: block; }
  .comment-box textarea,
  .sweep-panel .thrust {
    width: 100%; min-height: 64px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 6px 8px; line-height: 1.4;
    font: inherit; font-size: 12.5px;
  }
  .sweep-panel .thrust {
    min-height: 48px;
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #3bb26b) 55%, var(--input-border));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-testing-iconPassed, #3bb26b) 18%, transparent);
  }
  .sweep-panel .thrust:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #3bb26b) 75%, var(--border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-testing-iconPassed, #3bb26b) 45%, transparent);
  }
  .comment-box .row,
  .sweep-panel .row {
    display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px;
  }
  .stream {
    flex: 1 1 auto;
    min-height: 0; /* critical: allow shrink so overflow scrolls inside, not the page */
    overflow-y: auto;
    overflow-anchor: none;
    padding: 8px 12px 4px;
  }
  .stream.freeze {
    overflow-y: hidden;
  }
  /* Interview kickoff banner — normal stream flow (not sticky; sticky overlaid the card on scroll). */
  .stream #interview-start {
    padding-top: 4px;
    padding-bottom: 4px;
  }
  .msg {
    margin: 0 0 8px; padding: 7px 10px; border-radius: 5px;
    border-left: 2px solid transparent;
    font-size: 12.5px; line-height: 1.45;
  }
  .msg.user { background: var(--tint-user); border-left-color: var(--edge-user); }
  .msg.agent { background: var(--tint-agent); border-left-color: var(--edge-agent); }
  .msg.tool {
    display: flex; flex-direction: column; gap: 2px;
    background: var(--tint-tool); border-left-color: var(--edge-tool);
    padding: 5px 10px;
    color: color-mix(in srgb, var(--fg) 88%, transparent);
    font-size: 12px; line-height: 1.35;
  }
  .msg.tool .tool-name {
    font-weight: 600; font-family: var(--font);
    letter-spacing: 0.01em;
  }
  .msg.tool .toolpath {
    display: block; margin: 0;
    font-family: var(--font-mono); font-size: 11px;
    color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Live agent activity — same surface as the stream (no tinted band). */
  .activity {
    flex: 0 0 auto;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-top: none;
    background: var(--bg);
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.3;
    min-height: 28px;
    position: relative;
    z-index: 1;
  }
  .activity[hidden] { display: none !important; }
  .activity-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: var(--vscode-charts-blue, #18a0fb);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-charts-blue, #18a0fb) 50%, transparent);
    animation: activityPulse 1.2s ease-in-out infinite;
  }
  @keyframes activityPulse {
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--vscode-charts-blue, #18a0fb) 0%, transparent);
      opacity: 0.65;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .activity-dot { animation: none; }
  }
  .activity-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: color-mix(in srgb, var(--fg) 82%, transparent);
  }
  .activity-elapsed {
    flex: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .msg.sys {
    background: transparent; color: var(--muted); font-size: 11px;
    padding: 2px 4px; border-left: none; text-align: center;
  }
  .msg.sys#usage {
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }
  /* Empty stream — dark gray, quiet */
  .msg.sys.idle {
    color: color-mix(in srgb, var(--fg) 42%, transparent);
    font-size: 12px;
  }
  .msg.error {
    background: var(--tint-error); border-left-color: var(--edge-error);
    color: var(--vscode-errorForeground, #f44747);
  }
  /* No blinking caret on streaming agent text — stream body is enough. */
  .msg p { margin: 0 0 0.4em; }
  .msg p:last-child { margin-bottom: 0; }

  .composer {
    flex: none; border-top: 1px solid var(--border);
    padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 6px;
  }
  /* Auto-grows with content up to ~10 lines / 35% panel height, then scrolls
     (mirrors kettle-core #chatin growTextarea). Manual corner resize off. */
  .composer textarea {
    width: 100%; min-height: 52px; max-height: none; resize: none;
    overflow-y: hidden;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 6px 8px; line-height: 1.4;
    field-sizing: content; /* progressive; JS grow is the reliable path */
  }
  .composer .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .composer .grow { flex: 1; }
  .hint { font-size: 10.5px; color: var(--muted); }

  /* Founding interview confirmation card */
  .msg.confirm {
    border: 1px solid var(--border);
    border-left: 2px solid color-mix(in srgb, var(--vscode-textLink-foreground, #4daafc) 55%, transparent);
    background: color-mix(in srgb, var(--fg) 4%, transparent);
    padding: 10px 12px;
  }
  .msg.confirm .cc-title {
    font-size: 12.5px; font-weight: 600; margin: 0 0 8px;
    color: var(--vscode-textLink-foreground, #4daafc);
    letter-spacing: 0.03em;
  }
  .msg.confirm .cc-section {
    margin: 0 0 12px; padding: 0 0 10px;
    border-bottom: 1px solid var(--border);
  }
  .msg.confirm .cc-section:last-of-type { border-bottom: 0; padding-bottom: 0; }
  .msg.confirm .cc-stem {
    font-weight: 600; margin: 0 0 6px; line-height: 1.35; color: var(--fg);
  }
  .msg.confirm label.cc-opt {
    display: flex; gap: 8px; align-items: flex-start;
    margin: 4px 0; cursor: pointer; font-size: 12.5px; line-height: 1.35;
  }
  .msg.confirm label.cc-opt input { margin-top: 3px; flex: none; }
  .msg.confirm label.cc-opt span {
    flex: 1; min-width: 0; overflow-wrap: anywhere;
  }
  .msg.confirm .cc-elab {
    display: block; width: 100%; box-sizing: border-box; margin-top: 8px;
    min-height: 40px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    padding: 6px 8px; font: inherit;
  }
  .msg.confirm .cc-elab::placeholder {
    color: var(--muted); opacity: 0.85;
  }
  .msg.confirm .cc-actions {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px;
  }
  .msg.confirm .cc-confirm {
    --cc-blue: var(--vscode-textLink-foreground, #4daafc);
    background: color-mix(in srgb, var(--cc-blue) 82%, #0a1628);
    color: #fff; border-color: transparent;
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--cc-blue) 40%, transparent),
      0 0 10px color-mix(in srgb, var(--cc-blue) 40%, transparent),
      0 0 22px color-mix(in srgb, var(--cc-blue) 22%, transparent);
    animation: cc-glow 2.6s ease-in-out infinite;
  }
  .msg.confirm .cc-confirm:disabled { animation: none; opacity: 0.55; box-shadow: none; }
  @keyframes cc-glow {
    0%, 100% {
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--cc-blue) 30%, transparent),
        0 0 8px color-mix(in srgb, var(--cc-blue) 28%, transparent),
        0 0 16px color-mix(in srgb, var(--cc-blue) 14%, transparent);
    }
    50% {
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--cc-blue) 55%, transparent),
        0 0 14px color-mix(in srgb, var(--cc-blue) 50%, transparent),
        0 0 28px color-mix(in srgb, var(--cc-blue) 30%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .msg.confirm .cc-confirm { animation: none; }
  }
  .msg.confirm .cc-hint { font-size: 11px; color: var(--muted); }
  /* Interview only: hide ritual. Proposing shows Approve (found the desk). */
  body.interviewing .section.brief-sec,
  body.interviewing .section.comment-box,
  body.interviewing #btnApprove,
  body.interviewing #btnCommentToggle,
  body.interviewing #btnNotThis,
  body.interviewing #btnSweep { display: none; }
  body.interviewing .empty-cta,
  body.interviewing .sweep-panel { display: none !important; }
  /* Proposal phase: Approve is the founding gate — match web midfoot pulse. */
  body.proposing #btnCommentToggle,
  body.proposing #btnNotThis,
  body.proposing #btnSweep { display: none; }
  body.proposing .comment-box,
  body.proposing .sweep-panel { display: none !important; }
  body.proposing #btnApprove {
    display: inline-flex !important;
    --cc-blue: color-mix(in srgb, var(--vscode-charts-blue, #18a0fb) 88%, #fff);
    border-color: color-mix(in srgb, var(--cc-blue) 70%, transparent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--cc-blue) 45%, transparent),
      0 0 12px color-mix(in srgb, var(--cc-blue) 35%, transparent);
    animation: approvePulse 1.6s ease-in-out infinite;
  }
  body.proposing #btnApprove:disabled {
    animation: none;
    opacity: 0.45;
  }
  @keyframes approvePulse {
    50% {
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--cc-blue) 55%, transparent),
        0 0 14px color-mix(in srgb, var(--cc-blue) 50%, transparent),
        0 0 28px color-mix(in srgb, var(--cc-blue) 30%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    body.proposing #btnApprove { animation: none; }
  }
  body.founding .empty-cta { display: none !important; }
  /* Fixed founding pane — only during kickoff/card (not post-confirm stream) */
  #foundingPane {
    display: none;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    flex-direction: column;
    padding: 10px 12px;
  }
  body.founding-active #foundingPane { display: flex; }
  body.founding-active #stream { display: none; }
  body.founding-active .brief-sec,
  body.founding-active .comment-box { display: none; }
  /* After confirm, stream is the single surface — card stays in history above live work */
  body.founding-confirmed #foundingPane { display: none !important; }
  body.founding-confirmed #stream { display: block; }
  #foundingPane .fp-status {
    font-size: 13px; font-weight: 600; color: var(--fg); margin: 0 0 4px;
  }
  #foundingPane .fp-detail {
    font-size: 12px; color: var(--muted); margin: 0 0 10px; font-style: italic;
  }
  #foundingPane .fp-card {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-anchor: none;
  }
</style>
</head>
<body>
  <!--
    Desk anatomy (see file header in deskPanel.ts):
    header → brief → ritual → comment/sweep drawers → stream → composer
  -->
  <header class="top">
    <div class="chrome">
      <span class="conn" id="conn" title="status"></span>
      <div class="proj-wrap" id="projWrap">
        <button type="button" class="proj-select placeholder" id="btnProject"
                title="Select Kettle project" aria-label="Select Kettle project"
                aria-haspopup="listbox" aria-expanded="false" aria-controls="projMenu">
          <span class="proj-label" id="projLabel">Select project…</span>
          <svg class="chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="proj-menu" id="projMenu" role="listbox" hidden></div>
      </div>
      <button type="button" id="btnSettings" title="Settings" aria-label="Settings">${icon("gear")}</button>
      <div class="model-wrap" id="modelWrap">
        <button type="button" class="model-select placeholder" id="btnModel"
                title="Chat model" aria-label="Chat model"
                aria-haspopup="listbox" aria-expanded="false" aria-controls="modelMenu">
          <span class="model-label" id="modelLabel">Model…</span>
          <svg class="chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="model-menu" id="modelMenu" role="listbox" hidden></div>
      </div>
    </div>
    <div class="meta">
      <div class="path" id="path">${escapeHtml(uiState("attached", "line"))}</div>
    </div>
  </header>

  <div class="empty-cta" id="emptyCta">
    <button class="primary" id="btnSelectProject" title="Select a project or add a new folder">${icon("file")} Select or add project</button>
    <p class="hint">No project is open in this window. Pick one, or add any folder under your home (Kettle picks up an existing .kettle folder, or starts setting the project up).</p>
  </div>

  <section class="section brief-sec">
    <button type="button" class="brief-info-btn" id="btnBriefInfo"
      aria-label="About this summary" aria-expanded="false" aria-controls="briefInfoTip"
      title="About this summary">i</button>
    <div class="brief-info-tip" id="briefInfoTip" role="note" hidden>
      <strong>What is this?</strong>
      A short summary of the open file: what it is, what to look for, and the
      question the agent has for you. The agent writes it when it lines up a batch
      or refreshes summaries, so you can pick up a file without rereading all of it.
    </div>
    <div class="takeaway" id="takeaway" hidden></div>
    <div class="brief" id="brief"><p class="muted">Select a project to begin.</p></div>
  </section>

  <div class="actions actions-ritual">
    <button id="btnApprove" disabled title="${escapeHtml(uiCopy("approveHint"))}"><span class="btn-ico">${icon("check")}</span><span class="btn-label">${escapeHtml(uiCopy("approveLabel"))}</span></button>
    <button id="btnCommentToggle" disabled title="${escapeHtml(uiCopy("commentHint"))}"><span class="btn-ico">${icon("comment")}</span><span class="btn-label">${escapeHtml(uiCopy("commentLabel"))}</span></button>
    <button id="btnNotThis" disabled title="${escapeHtml(uiCopy("notThisHint"))}"><span class="btn-label">${escapeHtml(uiCopy("notThisLabel"))}</span></button>
    <button id="btnSweep" title="${escapeHtml(uiCopy("sweepHint"))}"><span class="btn-ico">${icon("play")}</span><span class="btn-label">${escapeHtml(uiCopy("sweepLabel"))}</span><span class="btn-label-short">${escapeHtml(uiCopy("sweepLabel", { short: true }))}</span></button>
  </div>

  <section class="section comment-box" id="commentBox">
    <div class="section-label">${escapeHtml(uiCopy("commentLabel"))}</div>
    <textarea id="commentText" placeholder="${escapeHtml(UI_COPY.commentPlaceholder)}" disabled></textarea>
    <div class="row">
      <button class="ghost" id="btnCommentCancel" type="button">${escapeHtml(uiCopy("cancelLabel"))}</button>
      <button id="btnCommentSave" disabled>${escapeHtml(uiCopy("commentSaveLabel"))}</button>
    </div>
  </section>

  <section class="section sweep-panel" id="sweepPanel">
    <div class="section-label">${escapeHtml(uiCopy("sweepConfirmTitle"))}</div>
    <p class="sweep-body">${escapeHtml(uiCopy("sweepConfirmBody"))}</p>
    <textarea class="thrust" id="thrust" rows="2" placeholder="${escapeHtml(uiCopy("sweepThrustPlaceholder"))}"></textarea>
    <div class="row">
      <button class="ghost" id="btnSweepCancel" type="button">${escapeHtml(uiCopy("cancelLabel"))}</button>
      <button id="btnSweepGo" type="button"><span class="btn-ico">${icon("play")}</span><span class="btn-label">${escapeHtml(uiCopy("sweepLabel"))}</span></button>
    </div>
  </section>

  <div class="stream" id="stream"></div>

  <div id="foundingPane" aria-live="polite">
    <div class="fp-status" id="fpStatus">Beginning Interview…</div>
    <div class="fp-detail" id="fpDetail">Surveying the Project…</div>
    <div class="fp-card" id="fpCard"></div>
  </div>

  <div class="activity" id="activity" hidden aria-live="polite">
    <span class="activity-dot" aria-hidden="true"></span>
    <span class="activity-label" id="activityLabel">working…</span>
    <span class="activity-elapsed" id="activityElapsed"></span>
  </div>

  <div class="composer">
    <textarea id="chatIn" rows="3" placeholder="${escapeHtml(UI_COPY.chatPlaceholder)}"></textarea>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let lastCommentFromHost = "";
  let hasEntry = false;
  let activityTimer = 0;
  let activityStart = 0;
  let freeze = false;
  let founding = false;
  let pinRaf = 0;
  let projectList = [];
  let currentProjectId = "";
  let modelList = [];
  let activeModelId = "";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function post(type, extra) {
    vscode.postMessage(Object.assign({ type: type }, extra || {}));
  }

  function setDisabled(ids, on) {
    ids.forEach(function(id) {
      const el = $(id);
      if (el) el.disabled = on;
    });
  }

  /** Set a ritual button's words from the host; keep the shipped words if absent. */
  function setRitualLabel(id, label, hint) {
    const el = $(id);
    if (!el) return;
    const labelEl = el.querySelector(".btn-label");
    if (label && labelEl) labelEl.textContent = label;
    if (hint) el.title = hint;
  }

  function setCommentOpen(open) {
    document.body.classList.toggle("comment-open", !!open);
  }

  // Finish batch with confirmation off: the drawer's button arms for 3 seconds and
  // reads Undo (catalog sweepUndoLabel); a second press cancels. With confirmation
  // on, the host asks in a modal instead.
  var confirmSweep = true;
  var sweepLabel = ${JSON.stringify(uiCopy("sweepLabel"))};
  var sweepUndoLabel = ${JSON.stringify(uiCopy("sweepUndoLabel"))};
  var sweepArm = null;

  function cancelSweepArm() {
    if (sweepArm) clearTimeout(sweepArm);
    sweepArm = null;
    const b = $("btnSweepGo");
    if (!b) return;
    b.classList.remove("arming");
    setRitualLabel("btnSweepGo", sweepLabel, "");
  }

  // Keep last steer text so a failed sweep can reopen without losing the note.
  var lastThrustDraft = "";

  function setSweepOpen(open, opts) {
    opts = opts || {};
    document.body.classList.toggle("sweep-open", !!open);
    if (open) {
      if (lastThrustDraft && !$("thrust").value) {
        $("thrust").value = lastThrustDraft;
      }
      return;
    }
    // Closing: remember draft unless caller says clear (successful sweep / Cancel).
    if (!opts.clear) {
      lastThrustDraft = $("thrust").value || lastThrustDraft;
    } else {
      lastThrustDraft = "";
      $("thrust").value = "";
    }
  }

  function applyState(msg) {
    const entry = msg.entry;
    hasEntry = !!entry;
    const proposing = !!msg.proposing || msg.foundingPhase === "proposing";
    // Interview chrome only — do not treat proposing as "founding hide ritual".
    founding = !!msg.founding && !proposing;
    freeze = !!msg.interviewFreeze;
    document.body.classList.toggle("founding", founding);
    document.body.classList.toggle("interviewing", founding);
    document.body.classList.toggle("proposing", proposing);
    document.body.classList.toggle("needs-project", !msg.projectId && !founding && !proposing);
    $("stream").classList.toggle("freeze", freeze);
    if (freeze || founding) startPinLoop();
    else stopPinLoop();

    $("conn").className = "conn" + (msg.connected ? " on" : "");
    $("conn").title = msg.statusText || (msg.connected ? "Connected" : "Offline");

    // Named project pill + in-panel dropdown.
    currentProjectId = msg.projectId ? String(msg.projectId) : "";
    if (Array.isArray(msg.projects)) projectList = msg.projects;
    const projWasOpen = $("btnProject") && $("btnProject").getAttribute("aria-expanded") === "true";
    renderProjectMenu();
    const projBtn = $("btnProject");
    const projLabel = $("projLabel");
    if (currentProjectId) {
      const row = projectList.find(function(p) { return p.id === currentProjectId; });
      projLabel.textContent = (row && (row.name || row.id)) || currentProjectId;
      projBtn.classList.remove("placeholder");
      projBtn.title = "Switch Kettle project";
    } else {
      projLabel.textContent = "Select project…";
      projBtn.classList.add("placeholder");
      projBtn.title = "Select Kettle project";
    }
    // State refresh rebuilds menu HTML — keep it open and re-anchored if it was open.
    if (projWasOpen) {
      $("projMenu").hidden = false;
      $("projMenu").removeAttribute("hidden");
      $("projMenu").classList.add("open");
      projBtn.setAttribute("aria-expanded", "true");
      placeFixedMenu($("projMenu"), projBtn);
    }

    // Chat model pill (core desk / VS Code chrome).
    if (Array.isArray(msg.models)) modelList = msg.models;
    activeModelId = msg.activeModelId ? String(msg.activeModelId) : "";
    const modelWasOpen = $("btnModel") && $("btnModel").getAttribute("aria-expanded") === "true";
    renderModelMenu();
    const modelBtn = $("btnModel");
    const modelLabel = $("modelLabel");
    if (activeModelId) {
      const row = modelList.find(function(m) { return m.id === activeModelId; });
      modelLabel.textContent = (row && (row.label || row.id)) || activeModelId;
      modelBtn.classList.remove("placeholder");
      modelBtn.title = "Switch chat model";
    } else if (modelList.length) {
      modelLabel.textContent = "Select model…";
      modelBtn.classList.add("placeholder");
      modelBtn.title = "Chat model";
    } else {
      modelLabel.textContent = "Model…";
      modelBtn.classList.add("placeholder");
      modelBtn.title = "No models available — start kettle-core";
    }
    if (modelWasOpen) {
      $("modelMenu").hidden = false;
      $("modelMenu").removeAttribute("hidden");
      $("modelMenu").classList.add("open");
      modelBtn.setAttribute("aria-expanded", "true");
      placeFixedMenu($("modelMenu"), modelBtn);
    }

    const pathEl = $("path");
    if (founding) {
      pathEl.textContent = ${JSON.stringify(uiCopy("foundingQueueHintTitle"))};
      pathEl.classList.remove("clickable");
      pathEl.title = "";
    } else if (entry) {
      pathEl.textContent = entry.displayPath || entry.path;
      pathEl.classList.add("clickable");
      pathEl.title = entry.path ? ("Open in editor — " + entry.path) : "Open in editor";
    } else if (msg.projectId) {
      pathEl.textContent = ${JSON.stringify(uiState("attached", "line"))};
      pathEl.classList.remove("clickable");
      pathEl.title = "";
    } else {
      // needs-project: path line is CSS-hidden; keep DOM empty to avoid flash
      pathEl.textContent = "";
      pathEl.classList.remove("clickable");
      pathEl.title = "";
    }

    // Takeaway — same block-quote chrome for file ask *and* initial project summary.
    // Host already stripMarkdownToPlain for both.
    const takeaway = $("takeaway");
    let takeawayText = "";
    if (!founding && entry && (entry.takeaway || entry.ask)) {
      takeawayText = String(entry.takeaway || entry.ask);
    } else if (
      !founding &&
      !proposing &&
      !entry &&
      msg.projectId &&
      msg.projectSummary
    ) {
      takeawayText = String(msg.projectSummary).trim();
    }
    if (takeawayText) {
      takeaway.hidden = false;
      takeaway.textContent = takeawayText;
    } else {
      takeaway.hidden = true;
      takeaway.textContent = "";
    }

    if (proposing) {
      // Whole HTML string injected by host (JSON.stringify) — never nest \${} / quotes.
      $("brief").innerHTML = ${JSON.stringify(
        `<p class="muted"><strong>${UI_COPY.proposingQueueHintTitle}</strong> — ${UI_COPY.proposingQueueHintBody}</p>`,
      )};
    } else if (founding) {
      // Canonical founding copy from kettle-core static/ui-copy.js (same source as web).
      $("brief").innerHTML = ${JSON.stringify(
        `<p class="muted"><strong>${UI_COPY.foundingQueueHintTitle}</strong> — ${UI_COPY.foundingQueueHintBody}</p>`,
      )};
    } else if (entry) {
      $("brief").innerHTML = entry.briefHtml || '<p class="muted">No summary yet.</p>';
    } else if (!msg.projectId) {
      // Project pill is the only CTA — no duplicate copy.
      $("brief").innerHTML = "";
    } else {
      // Project bound, no entry: summary is in #takeaway (quote style);
      // brief holds only the quiet “how to use the queue” hint.
      const body = (msg.noEntryBriefBody && String(msg.noEntryBriefBody).trim())
        || ${JSON.stringify(UI_COPY.noEntryBriefBody)};
      // Fallback quote if host sent no projectSummary.
      if (!takeawayText) {
        const summary = "Project “" + String(msg.projectId) + "” is open.";
        takeaway.hidden = false;
        takeaway.textContent = summary;
      }
      $("brief").innerHTML = '<p class="muted">' + esc(body) + "</p>";
    }

    const hostComment = entry ? (entry.comment || "") : "";
    if ($("commentText").value === lastCommentFromHost || !hasEntry) {
      $("commentText").value = hostComment;
    }
    lastCommentFromHost = hostComment;
    if (!hasEntry || founding || proposing) setCommentOpen(false);
    if (founding || proposing) setSweepOpen(false);

    // Host computes canonical enablement in ritualParity.ts (unit-tested).
    // The fallback keeps an old host message survivable during extension reload.
    const streaming = !!msg.streaming;
    const hasProject = !!msg.projectId;
    const approved = !!(entry && (entry.approved || entry.status === "approved"));
    const fallbackFileAct = !!entry && !founding && !streaming;
    // Labels and hints come from the host (core's catalog via ritualParity.ts);
    // the fallback keeps the shipped catalog words for an old host message.
    const ritual = msg.ritual || {
      canApprove: proposing ? !!entry && !streaming : fallbackFileAct && !approved,
      canComment: fallbackFileAct && !proposing,
      canNotThis: false,
      canSweep: hasProject && !founding && !proposing && !streaming
    };
    const canApprove = !!ritual.canApprove;
    const canComment = !!ritual.canComment;
    const canNotThis = !!ritual.canNotThis;
    const canSweep = !!ritual.canSweep;
    confirmSweep = msg.confirmSweep !== false;
    sweepLabel = ritual.sweepLabel || sweepLabel;
    sweepUndoLabel = ritual.sweepUndoLabel || sweepUndoLabel;

    document.body.classList.toggle("nofile", !entry && !proposing);
    document.body.classList.toggle("noproj", !hasProject);
    document.body.classList.toggle("streaming", streaming);
    document.body.classList.toggle("setaside", !!(entry && entry.setAside));

    setRitualLabel("btnApprove", ritual.approveLabel, ritual.approveHint);
    setRitualLabel("btnCommentToggle", ritual.commentLabel, ritual.commentHint);
    setRitualLabel("btnNotThis", ritual.notThisLabel, ritual.notThisHint);
    setRitualLabel("btnSweep", ritual.sweepLabel, ritual.sweepHint);
    const sweepShortEl = $("btnSweep").querySelector(".btn-label-short");
    if (sweepShortEl && ritual.sweepLabelShort) sweepShortEl.textContent = ritual.sweepLabelShort;
    if (!sweepArm) setRitualLabel("btnSweepGo", ritual.sweepLabel, "");

    setDisabled(["btnApprove"], !canApprove);
    setDisabled(["btnCommentToggle", "btnCommentSave", "commentText"], !canComment);
    setDisabled(["btnNotThis"], !canNotThis);
    // An armed Undo stays pressable: it is the only way to cancel the countdown.
    setDisabled(["btnSweep", "thrust"], !canSweep);
    if (!sweepArm) setDisabled(["btnSweepGo"], !canSweep);
    if (!canSweep && sweepArm) cancelSweepArm();
    setDisabled(["chatIn"], streaming);
    $("btnModel").disabled = streaming || !modelList.length;

    if (msg.chatPlaceholder) $("chatIn").placeholder = msg.chatPlaceholder;
  }

  function cleanStem(stem) {
    // Avoid /\\s/ /\\b/ regex literals here: this script is embedded in a host
    // template string and those escapes corrupt the webview JS (kills all handlers).
    var s = String(stem || "");
    s = s.replace(new RegExp("\\\\s*\\\\[[\\\\w]+\\\\]\\\\s*[·.]\\\\s*(multi|pick one)\\\\s*$", "i"), "");
    s = s.replace(new RegExp("\\\\s*\\\\((?:multi-select|single choice)\\\\)\\\\s*$", "i"), "");
    return s.trim();
  }

  function renderConfirmCard(card, opts) {
    opts = opts || {};
    const submitted = !!opts.submitted;
    let h = '<div class="msg confirm' + (submitted ? " submitted" : "") + '"'
      + (submitted ? ' data-submitted="1"' : "") + '>'
      + '<div class="cc-title">Setup Questions</div>';
    (card.sections || []).forEach(function(sec, si) {
      const stem = cleanStem(sec.stem);
      h += '<div class="cc-section" data-num="' + esc(sec.num) + '" data-id="' + esc(sec.id)
        + '" data-stem="' + esc(stem) + '" data-multi="' + (sec.multi ? "1" : "0") + '">';
      // Stem only — never render [id] · multi chrome
      h += '<div class="cc-stem">' + esc(stem) + '</div>';
      const group = "ccg-" + si;
      (sec.options || []).forEach(function(opt, oi) {
        const type = sec.multi ? "checkbox" : "radio";
        h += '<label class="cc-opt"><input type="' + type + '" name="' + group + '"'
          + (opt.checked ? " checked" : "")
          + (submitted ? " disabled" : "")
          + ' data-label="' + esc(opt.label) + '"/>'
          + '<span>' + esc(opt.label) + '</span></label>';
      });
      // Label lives in the placeholder — free text IS the “other” answer
      h += '<textarea class="cc-elab" rows="2" placeholder="Elaborate (optional)"'
        + ' aria-label="Elaborate (optional)"'
        + (submitted ? " disabled" : "") + '></textarea>';
      h += '</div>';
    });
    h += '<div class="cc-actions">'
      + '<button type="button" class="primary cc-confirm" id="btnConfirmCard"'
      + (submitted ? " disabled" : "") + '>'
      + (submitted ? "Confirmed — Drafting Proposal…" : "Confirm &amp; Draft Proposal")
      + '</button>'
      + '</div></div>';
    return h;
  }

  function applyFoundingView(msg) {
    const phase = msg.phase || "surveying";
    // Fixed pane only while surveying / preparing / interactive card.
    // Do NOT keep it for the whole interview (|| founding) — that hid #stream
    // and made the activity strip paint over the card after confirm.
    const active = phase === "surveying" || phase === "preparing" || phase === "card";
    const confirmed = phase === "confirmed" || phase === "streaming";
    document.body.classList.toggle("founding-active", active);
    document.body.classList.toggle("founding-confirmed", confirmed);
    document.body.classList.toggle("founding", founding || active || confirmed);
    $("fpStatus").textContent = msg.status || "Beginning Interview…";
    $("fpDetail").textContent = msg.detail || "";
    $("fpDetail").style.display = msg.detail ? "" : "none";
    const cardBox = $("fpCard");
    if (phase === "card" && msg.card) {
      cardBox.innerHTML = renderConfirmCard(msg.card);
      const confBtn = document.getElementById("btnConfirmCard");
      if (confBtn) {
        confBtn.addEventListener("click", function() {
          confBtn.disabled = true;
          post("confirmCard", { sections: collectConfirmCard() });
        });
      }
      cardBox.scrollTop = 0;
      pinStreamTop();
    } else if (phase === "surveying" || phase === "preparing") {
      cardBox.innerHTML = "";
      pinStreamTop();
    } else if (confirmed) {
      // Stream owns the surface now — stop pinning so new lines push the card up.
      cardBox.innerHTML = "";
      stopPinLoop();
    }
  }

  function collectConfirmCard() {
    const sections = [];
    document.querySelectorAll(".msg.confirm .cc-section").forEach(function(wrap) {
      const options = [];
      wrap.querySelectorAll("input").forEach(function(inp) {
        options.push({ label: inp.getAttribute("data-label") || "", checked: !!inp.checked });
      });
      const elab = wrap.querySelector(".cc-elab");
      sections.push({
        num: wrap.getAttribute("data-num") || "",
        id: wrap.getAttribute("data-id") || "",
        stem: wrap.getAttribute("data-stem") || "",
        multi: wrap.getAttribute("data-multi") === "1",
        options: options,
        elaborate: elab ? elab.value : "",
      });
    });
    return sections;
  }

  function pinStreamTop() {
    const box = $("stream");
    if (!box) return;
    // Prefer absolute top during freeze — content above the banner is none.
    box.scrollTop = 0;
    // Also kill any accidental document scroll (should be locked by CSS).
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }

  function startPinLoop() {
    if (pinRaf) return;
    const tick = function() {
      if (!freeze && !founding) {
        pinRaf = 0;
        return;
      }
      // After confirm, card has data-submitted — allow the stream to follow new work.
      const openCard = $("stream").querySelector(".msg.confirm:not([data-submitted])");
      if (freeze || openCard) {
        pinStreamTop();
      } else {
        pinRaf = 0;
        return;
      }
      pinRaf = requestAnimationFrame(tick);
    };
    pinRaf = requestAnimationFrame(tick);
  }

  function stopPinLoop() {
    if (pinRaf) {
      cancelAnimationFrame(pinRaf);
      pinRaf = 0;
    }
  }

  function setActivityBar(active, label) {
    const bar = $("activity");
    const lab = $("activityLabel");
    const el = $("activityElapsed");
    if (!bar) return;
    if (active) {
      bar.hidden = false;
      if (lab) lab.textContent = label || "working…";
      if (!activityTimer) {
        activityStart = Date.now();
        if (el) el.textContent = "";
        activityTimer = setInterval(function() {
          const s = Math.floor((Date.now() - activityStart) / 1000);
          if (el) el.textContent = s >= 2 ? s + "s" : "";
        }, 500);
      }
    } else {
      bar.hidden = true;
      if (lab) lab.textContent = "working…";
      if (el) el.textContent = "";
      if (activityTimer) {
        clearInterval(activityTimer);
        activityTimer = 0;
      }
    }
  }

  function applyStream(msg) {
    const box = $("stream");
    if (typeof msg.freeze === "boolean") {
      freeze = msg.freeze;
      box.classList.toggle("freeze", freeze);
    }
    const cardSubmitted = msg.cardSubmitted === true
      || document.body.classList.contains("founding-confirmed");
    // Only pin when host asks, or during kickoff freeze — not merely because a
    // (submitted) confirm card is still in history.
    const pinTop = msg.pinTop === true || freeze;
    const lines = msg.lines || [];
    if (!lines.length) {
      box.innerHTML = "";
    } else {
      // Hide empty streaming stubs — they were the blank "…" bubbles between tools.
      const visible = lines.filter(function(line) {
        if (line.kind === "agent" && line.streaming && !(line.text || "").trim() && !line.html) {
          return false;
        }
        if (line.kind === "agent" && !(line.text || "").trim() && !line.streaming && !line.html) {
          return false;
        }
        return true;
      });
      box.innerHTML = visible.map(function(line) {
        if (line.kind === "confirm" && line.card) {
          return renderConfirmCard(line.card, {
            submitted: cardSubmitted || line.submitted === true,
          });
        }
        const streaming = line.kind === "agent" && line.streaming;
        const idAttr = line.id ? ' id="' + esc(line.id) + '"' : "";
        const cls = "msg " + line.kind + (streaming ? " streaming" : "");
        const body = line.html || esc(line.text || "");
        return '<div class="' + cls + '"' + idAttr + '>' + body + '</div>';
      }).join("");
      const confBtn = document.getElementById("btnConfirmCard");
      if (confBtn && !confBtn.disabled) {
        confBtn.addEventListener("click", function() {
          confBtn.disabled = true;
          post("confirmCard", { sections: collectConfirmCard() });
        });
      }
    }
    const openCard = !!box.querySelector(".msg.confirm:not([data-submitted])");
    // Unsubmitted card / freeze: pin to top. After confirm: follow the tail so
    // thinking + draft lines push the interview upward.
    if (pinTop || openCard) {
      pinStreamTop();
      startPinLoop();
    } else {
      stopPinLoop();
      box.scrollTop = box.scrollHeight;
    }
  }

  function applyRitualZoom(dampen) {
    var d = Number(dampen);
    if (!Number.isFinite(d) || d <= 0) d = 1;
    document.documentElement.style.setProperty("--ritual-dampen", String(d));
  }

  var projectOutsideBound = null;
  var modelOutsideBound = null;

  function placeFixedMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 320;
    const vh = window.innerHeight || document.documentElement.clientHeight || 480;
    // Mirrors packages/vscode/src/projectMenu.ts fixedMenuStyle (keep in sync).
    const gap = 6;
    const minWidth = 280;
    const maxW = Math.max(160, vw - 16);
    const width = Math.min(Math.max(r.width, minWidth), maxW);
    var left = r.left;
    if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);
    if (left < 8) left = 8;
    var top = r.bottom + gap;
    if (top > vh - 40) top = Math.max(8, r.top - gap);
    menu.style.position = "fixed";
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    menu.style.width = Math.round(width) + "px";
    menu.style.maxWidth = Math.round(maxW) + "px";
    menu.style.right = "auto";
    menu.style.zIndex = "10000";
  }

  function clearFixedMenu(menu) {
    menu.style.position = "";
    menu.style.left = "";
    menu.style.top = "";
    menu.style.width = "";
    menu.style.maxWidth = "";
    menu.style.right = "";
    menu.style.zIndex = "";
  }

  function setProjectMenuOpen(open) {
    const menu = $("projMenu");
    const btn = $("btnProject");
    if (!menu || !btn) return;
    if (projectOutsideBound) {
      document.removeEventListener("mousedown", projectOutsideBound, true);
      projectOutsideBound = null;
    }
    if (open) {
      setModelMenuOpen(false);
      menu.hidden = false;
      menu.removeAttribute("hidden");
      menu.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      placeFixedMenu(menu, btn);
      // Defer outside-close so the opening gesture cannot immediately dismiss.
      projectOutsideBound = function(e) {
        const t = e.target;
        if (menu.contains(t) || btn.contains(t) || ($("projWrap") && $("projWrap").contains(t))) {
          return;
        }
        setProjectMenuOpen(false);
      };
      setTimeout(function() {
        if (projectOutsideBound) {
          document.addEventListener("mousedown", projectOutsideBound, true);
        }
      }, 0);
    } else {
      menu.classList.remove("open");
      menu.hidden = true;
      menu.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
      clearFixedMenu(menu);
    }
  }

  function setModelMenuOpen(open) {
    const menu = $("modelMenu");
    const btn = $("btnModel");
    if (!menu || !btn) return;
    if (modelOutsideBound) {
      document.removeEventListener("mousedown", modelOutsideBound, true);
      modelOutsideBound = null;
    }
    if (open) {
      // Close project without clearing model closer mid-flight.
      const pmenu = $("projMenu");
      const pbtn = $("btnProject");
      if (pmenu && pbtn && pbtn.getAttribute("aria-expanded") === "true") {
        if (projectOutsideBound) {
          document.removeEventListener("mousedown", projectOutsideBound, true);
          projectOutsideBound = null;
        }
        pmenu.classList.remove("open");
        pmenu.hidden = true;
        pmenu.setAttribute("hidden", "");
        pbtn.setAttribute("aria-expanded", "false");
        clearFixedMenu(pmenu);
      }
      menu.hidden = false;
      menu.removeAttribute("hidden");
      menu.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      placeFixedMenu(menu, btn);
      modelOutsideBound = function(e) {
        const t = e.target;
        if (menu.contains(t) || btn.contains(t) || ($("modelWrap") && $("modelWrap").contains(t))) {
          return;
        }
        setModelMenuOpen(false);
      };
      setTimeout(function() {
        if (modelOutsideBound) {
          document.addEventListener("mousedown", modelOutsideBound, true);
        }
      }, 0);
    } else {
      menu.classList.remove("open");
      menu.hidden = true;
      menu.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
      clearFixedMenu(menu);
    }
  }

  function renderModelMenu() {
    const menu = $("modelMenu");
    if (!menu) return;
    let html = "";
    if (!modelList.length) {
      html += '<div class="proj-opt empty" role="option" aria-disabled="true">'
        + "No models — check the agent settings in Kettle</div>";
    } else {
      modelList.forEach(function(m) {
        const active = m.id === activeModelId ? " active" : "";
        html += '<button type="button" class="proj-opt' + active
          + '" role="option" data-id="' + esc(m.id) + '" data-provider="'
          + esc(m.provider || "") + '"'
          + (m.id === activeModelId ? ' aria-selected="true"' : ' aria-selected="false"')
          + '><span class="opt-name">' + esc(m.label || m.id) + "</span>"
          + (m.provider
            ? '<span class="opt-meta">' + esc(m.provider) + "</span>"
            : "")
          + "</button>";
      });
    }
    menu.innerHTML = html;
    menu.querySelectorAll(".proj-opt[data-id]").forEach(function(el) {
      el.addEventListener("click", function(ev) {
        ev.stopPropagation();
        const id = el.getAttribute("data-id");
        const provider = el.getAttribute("data-provider") || undefined;
        setModelMenuOpen(false);
        if (id && id !== activeModelId) {
          post("setChatModel", { modelId: id, provider: provider });
        }
      });
    });
  }

  function renderProjectMenu() {
    const menu = $("projMenu");
    if (!menu) return;
    let html = "";
    if (!projectList.length) {
      html += '<div class="proj-opt empty" role="option" aria-disabled="true">'
        + "No projects registered yet</div>";
    } else {
      projectList.forEach(function(p) {
        const active = p.id === currentProjectId ? " active" : "";
        // Path only — no "not this workspace" (switching project loads that folder).
        var rootShown = String(p.root || "");
        if (rootShown.indexOf("/Users/") === 0) {
          var rest = rootShown.slice("/Users/".length);
          var slash = rest.indexOf("/");
          rootShown = slash >= 0 ? "~" + rest.slice(slash) : "~";
        }
        html += '<button type="button" class="proj-opt' + active
          + '" role="option" data-id="' + esc(p.id) + '"'
          + (p.id === currentProjectId ? ' aria-selected="true"' : ' aria-selected="false"')
          + '><span class="opt-name">' + esc(p.name || p.id) + "</span>"
          + '<span class="opt-meta">' + esc(rootShown) + "</span></button>";
      });
    }
    // Register only — no "All projects / filter" row (command palette keeps QuickPick).
    html += '<button type="button" class="proj-opt sep" role="option" data-action="register">'
      + '<span class="opt-name">Register new project…</span>'
      + '<span class="opt-meta">browse for any folder under home</span></button>';
    menu.innerHTML = html;
    menu.querySelectorAll(".proj-opt[data-id]").forEach(function(el) {
      el.addEventListener("click", function(ev) {
        ev.stopPropagation();
        const id = el.getAttribute("data-id");
        setProjectMenuOpen(false);
        if (id && id !== currentProjectId) post("selectProject", { projectId: id });
      });
    });
    const regBtn = menu.querySelector('.proj-opt[data-action="register"]');
    if (regBtn) {
      regBtn.addEventListener("click", function(ev) {
        ev.stopPropagation();
        setProjectMenuOpen(false);
        post("registerProject");
      });
    }
  }

  window.addEventListener("message", function(e) {
    const msg = e.data || {};
    if (msg.type === "state") {
      applyState(msg);
      // Keep activity bar in sync if host streams without a discrete activity event.
      if (msg.streaming && $("activity") && $("activity").hidden) {
        setActivityBar(true, "working…");
      }
      if (!msg.streaming && $("activity") && !$("activity").hidden) {
        setActivityBar(false, "");
      }
    } else if (msg.type === "activity") {
      setActivityBar(!!msg.active, msg.label || "working…");
    } else if (msg.type === "ritualZoom") {
      applyRitualZoom(msg.dampen);
    } else if (msg.type === "stream") {
      applyStream(msg);
      // Host always sends streaming on stream posts; only then sync the strip
      // (older builds omitted the flag and wiped the bar on every line).
      if (typeof msg.streaming === "boolean") {
        if (msg.streaming) {
          setActivityBar(true, $("activityLabel")?.textContent || "working…");
        } else {
          setActivityBar(false, "");
        }
      }
    }
    else if (msg.type === "sweepDone") {
      if (msg.ok) {
        lastThrustDraft = "";
        $("thrust").value = "";
        setSweepOpen(false, { clear: true });
      } else {
        // Restore crafted steer note and reopen the drawer.
        if (msg.thrust != null) {
          lastThrustDraft = String(msg.thrust);
          $("thrust").value = lastThrustDraft;
        }
        setCommentOpen(false);
        setSweepOpen(true);
        $("thrust").focus();
      }
    }
    else if (msg.type === "foundingView") applyFoundingView(msg);
    else if (msg.type === "freeze") {
      freeze = !!msg.freeze;
      $("stream").classList.toggle("freeze", freeze);
      if (freeze) {
        pinStreamTop();
        startPinLoop();
      } else if (!founding) {
        stopPinLoop();
      }
    }
  });

  $("btnApprove").addEventListener("click", function() { post("approve"); });

  // Brief info: tiny "i" — no section title chrome.
  function setBriefInfoOpen(open) {
    const tip = $("briefInfoTip");
    const btn = $("btnBriefInfo");
    if (!tip || !btn) return;
    if (open) {
      tip.hidden = false;
      tip.removeAttribute("hidden");
      tip.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    } else {
      tip.classList.remove("open");
      tip.hidden = true;
      tip.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
    }
  }
  $("btnBriefInfo").addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    const open = $("btnBriefInfo").getAttribute("aria-expanded") !== "true";
    setBriefInfoOpen(open);
  });
  document.addEventListener("mousedown", function(e) {
    const tip = $("briefInfoTip");
    const btn = $("btnBriefInfo");
    if (!tip || !btn || btn.getAttribute("aria-expanded") !== "true") return;
    const t = e.target;
    if (tip.contains(t) || btn.contains(t)) return;
    setBriefInfoOpen(false);
  }, true);
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") setBriefInfoOpen(false);
  });

  // Comment: toggle drawer (not a permanent second essay box).
  $("btnCommentToggle").addEventListener("click", function() {
    const open = !document.body.classList.contains("comment-open");
    setCommentOpen(open);
    if (open) {
      setSweepOpen(false);
      $("commentText").focus();
    }
  });
  $("btnCommentCancel").addEventListener("click", function() {
    setCommentOpen(false);
    $("commentText").value = lastCommentFromHost;
  });
  $("btnCommentSave").addEventListener("click", function() {
    post("comment", { text: $("commentText").value });
    lastCommentFromHost = $("commentText").value;
    setCommentOpen(false);
  });

  // Not this / Bring back: one press, no prompt. The host decides which by the
  // file's status and refreshes the queue.
  $("btnNotThis").addEventListener("click", function() { post("notThis"); });

  // Finish batch: toggle the steer drawer under the ritual bar (same pattern as Comment).
  $("btnSweep").addEventListener("click", function() {
    const open = !document.body.classList.contains("sweep-open");
    if (!open) cancelSweepArm();
    setSweepOpen(open);
    if (open) {
      setCommentOpen(false);
      $("thrust").focus();
    }
  });
  $("btnSweepCancel").addEventListener("click", function() {
    cancelSweepArm();
    setSweepOpen(false, { clear: true });
  });
  function startSweep() {
    const thrust = $("thrust").value;
    lastThrustDraft = thrust; // keep until success (host posts sweepDone)
    setSweepOpen(false); // hide drawer but keep draft
    post("sweep", { thrust: thrust });
  }
  $("btnSweepGo").addEventListener("click", function() {
    if (sweepArm) { cancelSweepArm(); return; } // second press during countdown = Undo
    if (confirmSweep) { startSweep(); return; }  // host confirms in a modal
    const b = $("btnSweepGo");
    b.classList.add("arming");
    setRitualLabel("btnSweepGo", sweepUndoLabel, "");
    sweepArm = setTimeout(function() {
      sweepArm = null;
      b.classList.remove("arming");
      setRitualLabel("btnSweepGo", sweepLabel, "");
      startSweep();
    }, 3000);
  });
  $("thrust").addEventListener("keydown", function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      $("btnSweepGo").click();
    }
  });
  $("thrust").addEventListener("input", function() {
    lastThrustDraft = $("thrust").value;
  });

  $("btnSettings").addEventListener("click", function() { post("settings"); });
  $("btnProject").addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    const open = $("btnProject").getAttribute("aria-expanded") === "true";
    if (!open) post("refreshProjects");
    // Open immediately so the click is not a no-op if refresh is slow.
    setProjectMenuOpen(!open);
  });
  $("btnModel").addEventListener("click", function(e) {
    e.preventDefault();
    e.stopPropagation();
    if ($("btnModel").disabled) return;
    const open = $("btnModel").getAttribute("aria-expanded") === "true";
    if (!open) post("refreshModels");
    setModelMenuOpen(!open);
  });
  // Reposition while open (zoom / sidebar resize).
  window.addEventListener("resize", function() {
    if ($("btnProject").getAttribute("aria-expanded") === "true") {
      placeFixedMenu($("projMenu"), $("btnProject"));
    }
    if ($("btnModel").getAttribute("aria-expanded") === "true") {
      placeFixedMenu($("modelMenu"), $("btnModel"));
    }
  });
  $("btnSelectProject").addEventListener("click", function() {
    // Empty-state CTA: open in-panel menu when we have projects;
    // otherwise go straight to register (folder browser).
    if (projectList.length) {
      setProjectMenuOpen(true);
      $("btnProject").focus();
    } else {
      post("registerProject");
    }
  });
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") {
      setProjectMenuOpen(false);
      setModelMenuOpen(false);
    }
  });
  $("path").addEventListener("click", function() {
    if ($("path").classList.contains("clickable")) post("openEntry");
  });
  /**
   * Grow #chatIn with content, then scroll.
   * Cap = min(~10 lines, 35% of the desk viewport) so the stream stays primary
   * even in a short secondary sidebar. Matches kettle-core growTextarea.
   */
  function growChatIn() {
    const el = $("chatIn");
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 18;
    const extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const byLines = Math.round(line * 10 + extra);
    const byViewport = Math.floor(window.innerHeight * 0.35);
    const minH = 52;
    const cap = Math.max(minH, Math.min(byLines, byViewport));
    const next = Math.min(Math.max(el.scrollHeight, minH), cap);
    el.style.height = next + "px";
    el.style.overflowY = el.scrollHeight > cap + 1 ? "auto" : "hidden";
  }
  function sendChat() {
    const raw = $("chatIn").value;
    const text = raw.trim();
    if (!text) return;
    $("chatIn").value = "";
    growChatIn();
    // Local slash commands — do not round-trip as curator chat.
    // NOTE: this script lives inside a host template literal — avoid \\b/\\s regex
    // escapes here (they corrupt the webview JS and kill ALL click handlers).
    var low = text.toLowerCase();
    if (low === "compact" || low === "/compact" || low.indexOf("/compact ") === 0) {
      post("compact");
      return;
    }
    post("chat", { text: raw });
  }
  // Enter sends; Shift+Enter inserts a newline (no Send button).
  $("chatIn").addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  $("chatIn").addEventListener("input", growChatIn);
  window.addEventListener("resize", growChatIn);
  growChatIn();

  post("ready");
</script>
</body>
</html>`;
}

function icon(name: string, cls = "icon-svg"): string {
  // Paths tuned for optical balance inside a 16×16 slot next to a label.
  const paths: Record<string, string> = {
    // Centered check (mass balanced around mid of viewBox)
    check:
      '<path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z"/>',
    // Speech bubble centered in the square
    comment:
      '<path d="M2.5 2.75A1.75 1.75 0 014.25 1h7.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0111.75 10H8.06l-2.47 2.47A.75.75 0 014.25 12V10h-.5A1.75 1.75 0 012 8.25v-5.5z"/>',
    // Play triangle with more trailing room so it doesn’t feel left-cramped
    play: '<path d="M5.25 3.6v8.8l7-4.4-7-4.4z"/>',
    stop: '<path d="M4 4h8v8H4z"/>',
    // Conventional settings cog — outer ring teeth + center hub (reads clearly at 16px).
    gear:
      '<path d="M6.7 1.4h2.6l.3 1.4c.35.1.68.25.98.45l1.35-.55 1.3 1.3-.55 1.35c.2.3.35.63.45.98l1.4.3v2.6l-1.4.3c-.1.35-.25.68-.45.98l.55 1.35-1.3 1.3-1.35-.55c-.3.2-.63.35-.98.45l-.3 1.4H6.7l-.3-1.4a4.4 4.4 0 01-.98-.45l-1.35.55-1.3-1.3.55-1.35a4.4 4.4 0 01-.45-.98L1.47 9.3V6.7l1.4-.3c.1-.35.25-.68.45-.98l-.55-1.35 1.3-1.3 1.35.55c.3-.2.63-.35.98-.45l.3-1.4zM8 5.5A2.5 2.5 0 108 10.5 2.5 2.5 0 008 5.5z"/>',
    file: '<path d="M4 2h5l3 3v9H4V2zm1 1v10h6V6H8V3H5z"/>',
    diff: '<path d="M3 2h1v3h3v1H4v3H3V6H0V5h3V2zm6 5h1v2h2v1H10v2H9v-2H7V9h2V7z"/>',
    send: '<path d="M2 8l12-5-5 12-1.5-5L2 8zm3.2.4l3.3 1.2L10.8 5.2 5.2 8.4z"/>',
  };
  const d = paths[name] || paths.file;
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}
