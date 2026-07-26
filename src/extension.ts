import { spawn } from "node:child_process";
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  Project,
  QueueEntry,
  KettleApi,
  KettleApiError,
  type StreamEvent,
} from "./api";
import { registerKettleParticipant } from "./chat/participant";
import { registerKettleTools } from "./chat/tools";
import * as debug from "./debug";
import { DeskPanelProvider } from "./deskPanel";
import { resolveCoreBaseUrl } from "./discover";
import {
  KettleCompatibilityError,
  assertCoreCompatibility,
} from "./compatibility";
import {
  entryAbsPath,
  findEntryForEditorPath,
  kettleDeskDir,
} from "./paths";
import {
  findProjectByRoot,
  isApprovedEntry,
  nameFromRootPath,
  nextPendingEntry,
  resolveProjectId as matchProjectId,
  tryRealpath,
  workspaceMatchesProject,
} from "./project";
import { registerQueueView, type QueueTreeProvider } from "./queueView";
import {
  isProposalEntry,
  proposalDocumentPath,
  proposalEntryForFounding,
  shouldPostCompact,
} from "./ritualParity";
import {
  buildSelectionProbe,
  formatRevealProbe,
  formatSelectionProbe,
} from "./selectionSync";
import {
  disposeSidecar,
  ensureCore,
  restartCore,
  type SidecarState,
} from "./sidecar";
import * as state from "./state";
import { UI_COPY } from "./uiCopy";

let cached: { baseUrl: string; api: KettleApi } | null = null;
let deskPanel: DeskPanelProvider | undefined;
let queueView: QueueTreeProvider | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let sidecar: SidecarState | undefined;

// Settings, with one-release fallback reads of the pre-0.3 keys (baseUrl, projectId).
function cfgServerUrl(): string {
  const cfg = vscode.workspace.getConfiguration("kettle");
  return (cfg.get<string>("serverUrl") || cfg.get<string>("baseUrl") || "").trim();
}

function cfgProject(): string {
  const cfg = vscode.workspace.getConfiguration("kettle");
  return (cfg.get<string>("project") || cfg.get<string>("projectId") || "").trim();
}

function cfgConfirmSweep(): boolean {
  return vscode.workspace.getConfiguration("kettle").get<boolean>("confirmSweep", true);
}

/** Soft confirm before approve (default true). */
function cfgConfirmApprove(): boolean {
  return vscode.workspace.getConfiguration("kettle").get<boolean>("confirmApprove", true);
}

/** After approve, open the next pending queue entry (default true). */
function cfgOpenNextOnApprove(): boolean {
  return vscode.workspace.getConfiguration("kettle").get<boolean>("openNextOnApprove", true);
}

function cfgProvider(): string {
  return (vscode.workspace.getConfiguration("kettle").get<string>("provider") || "").trim();
}

function cfgChatModel(): string {
  return (vscode.workspace.getConfiguration("kettle").get<string>("chatModel") || "").trim();
}

function cfgSetupModel(): string {
  return (vscode.workspace.getConfiguration("kettle").get<string>("setupModel") || "").trim();
}

function cfgEffort(): string {
  return (vscode.workspace.getConfiguration("kettle").get<string>("effort") || "").trim();
}

/** Live-stream narration verbosity during a sweep (empty = leave core's current value). */
function cfgSweepVerbosity(): string {
  return (
    vscode.workspace.getConfiguration("kettle").get<string>("sweepVerbosity") || ""
  ).trim();
}

/** Auto-trigger Sweep once every queue entry is approved/rework (default off). */
function cfgAutoSweepOnQueueDone(): boolean {
  return vscode.workspace
    .getConfiguration("kettle")
    .get<boolean>("autoSweepOnQueueDone", false);
}

/** True while we write editor settings from core (avoid re-push loops). */
let syncingCuratorFromCore = false;

/**
 * Push editor curator settings → core.
 * Empty strings mean "don't override that field" (leave core as-is for that key).
 */
async function pushCuratorSettingsToCore(): Promise<void> {
  if (syncingCuratorFromCore) return;
  const provider = cfgProvider();
  const chatModel = cfgChatModel();
  const setupModel = cfgSetupModel();
  const effort = cfgEffort();

  // Nothing set in editor — leave core alone.
  if (!provider && !chatModel && !setupModel && !effort) return;

  try {
    const client = await api();
    const models: Record<string, string> = {};
    if (chatModel) models.chat = chatModel;
    if (setupModel) models.setup = setupModel;
    else if (chatModel) models.setup = chatModel;

    await client.setCuratorSelection({
      provider: provider || undefined,
      model: chatModel || setupModel || undefined,
      task: chatModel ? "chat" : setupModel ? "setup" : "chat",
      effort: effort || undefined,
      models: Object.keys(models).length ? models : undefined,
    });
    // Distinct setup model needs a second task write when chat was also set.
    if (setupModel && chatModel && setupModel !== chatModel) {
      await client.setCuratorSelection({
        provider: provider || undefined,
        model: setupModel,
        task: "setup",
        models,
      });
    }
    deskPanel?.refresh();
  } catch (e) {
    debug.log(
      `pushCuratorSettingsToCore failed: ${e instanceof Error ? e.message : e}`,
    );
    void vscode.window.showErrorMessage(
      formatErr("Could not apply curator settings to Kettle core", e),
    );
  }
}

/**
 * Push kettle.sweepVerbosity → core's settings.json (shared with the Desk web UI
 * and CLI — sweep narration is a core-wide preference, not per-client).
 * Empty = don't override core's current value.
 */
async function pushBehaviorSettingsToCore(): Promise<void> {
  const sweepVerbosity = cfgSweepVerbosity();
  if (!sweepVerbosity) return;
  try {
    await (await api()).patchSettings({ sweepVerbosity });
  } catch (e) {
    debug.log(
      `pushBehaviorSettingsToCore failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Pull core active curator into empty editor settings (first run / blank fields only). */
async function pullCuratorSettingsFromCore(): Promise<void> {
  try {
    const cat = await (await api()).curatorCatalog();
    const active = cat.active;
    if (!active) return;
    const chat =
      active.models?.chat ||
      (active as { chat?: string }).chat ||
      "";
    const setup =
      active.models?.setup ||
      (active as { setup?: string }).setup ||
      "";
    const provider = active.provider || "";
    const cfg = vscode.workspace.getConfiguration("kettle");
    syncingCuratorFromCore = true;
    try {
      // Only fill blanks so we don't clobber explicit editor overrides.
      if (!cfgProvider() && provider) {
        await cfg.update("provider", provider, vscode.ConfigurationTarget.Global);
      }
      if (!cfgChatModel() && chat) {
        await cfg.update("chatModel", chat, vscode.ConfigurationTarget.Global);
      }
      if (!cfgSetupModel() && setup) {
        await cfg.update("setupModel", setup, vscode.ConfigurationTarget.Global);
      }
    } finally {
      syncingCuratorFromCore = false;
    }
  } catch {
    syncingCuratorFromCore = false;
  }
}

/** Write editor settings to match a Desk model-pill selection. */
async function mirrorChatModelToEditorSettings(
  modelId: string,
  provider?: string,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("kettle");
  syncingCuratorFromCore = true;
  try {
    await cfg.update("chatModel", modelId, vscode.ConfigurationTarget.Global);
    if (provider) {
      await cfg.update("provider", provider, vscode.ConfigurationTarget.Global);
    }
  } finally {
    syncingCuratorFromCore = false;
  }
}

function entryBasename(entryPath: string): string {
  const norm = entryPath.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] || entryPath;
}

/**
 * Soft confirm before approve (matches the VS Code sitting).
 * "Don't ask again" writes kettle.confirmApprove=false globally, then proceeds.
 * Uses InformationMessage — not Warning — so it does not read as a danger dialog.
 */
async function confirmApprove(
  entryPath: string,
  opts?: { foundingProposal?: boolean },
): Promise<boolean> {
  if (!cfgConfirmApprove()) return true;

  const label = entryBasename(entryPath);
  if (opts?.foundingProposal) {
    const choice = await vscode.window.showInformationMessage(
      "Found the desk from this proposal?",
      {
        modal: true,
        detail:
          "Kettle will use your edited DESK-PROPOSAL.md as the charter, write the desk files, and stock the first queue batch. You can amend the desk later.",
      },
      "Found Desk",
    );
    return choice === "Found Desk";
  }

  const choice = await vscode.window.showInformationMessage(
    `Approve this version of ${label}?`,
    {
      modal: true,
      detail:
        'This will mark the file as approved in the Kettle queue. You must click the "sweep" button for the agent to commit and process this batch of files.',
    },
    "Approve",
    "Don't ask again",
  );
  if (choice === "Don't ask again") {
    await vscode.workspace
      .getConfiguration("kettle")
      .update("confirmApprove", false, vscode.ConfigurationTarget.Global);
    return true;
  }
  return choice === "Approve";
}

/** Focus Kettle Desk on activate (default true — brings sitting over Agent on Cursor). */
function cfgFocusDeskOnActivate(): boolean {
  return vscode.workspace.getConfiguration("kettle").get<boolean>("focusDeskOnActivate", true);
}

/**
 * How to handle a desk whose root is not this window's folder.
 * - ask — dialog each time
 * - switchFolder — single-project window
 * - kettleWorkspace — multi-root ~/.kettle/Kettle.code-workspace
 */
function cfgProjectSwitchMode(): "ask" | "switchFolder" | "kettleWorkspace" {
  const v = vscode.workspace
    .getConfiguration("kettle")
    .get<string>("projectSwitchMode", "ask");
  if (v === "switchFolder" || v === "kettleWorkspace" || v === "ask") return v;
  return "ask";
}

function cfgAutoStartServer(): boolean {
  // Product default: plugin launch starts the live core (opt-out via settings).
  return vscode.workspace.getConfiguration("kettle").get<boolean>("autoStartServer", true);
}

function cfgCommand(): string {
  const c = vscode.workspace.getConfiguration("kettle").get<string>("command", "kettle");
  return (c || "kettle").trim() || "kettle";
}

function preferredCoreUrl(): string {
  return (cfgServerUrl() || "http://127.0.0.1:4242").replace(/\/$/, "");
}

/**
 * Resolve a live KettleApi: attach to a healthy core, or auto-start one.
 * Auto-start is the product default (kettle.autoStartServer).
 */
async function api(): Promise<KettleApi> {
  if (cached) {
    try {
      const p = await cached.api.ping();
      if (p.app === "kettle" || p.app === "setsweep") {
        assertCoreCompatibility(p);
        return cached.api;
      }
    } catch (error) {
      cached = null;
      if (error instanceof KettleCompatibilityError) throw error;
    }
  }
  try {
    const { baseUrl } = await resolveCoreBaseUrl(cfgServerUrl());
    cached = { baseUrl, api: new KettleApi(baseUrl) };
    return cached.api;
  } catch (discoverErr) {
    if (discoverErr instanceof KettleCompatibilityError) throw discoverErr;
    if (!cfgAutoStartServer()) throw discoverErr;
    const next = await ensureCore({
      preferredUrl: preferredCoreUrl(),
      command: cfgCommand(),
      autoStart: true,
    });
    sidecar = next;
    const client = new KettleApi(next.baseUrl);
    assertCoreCompatibility(await client.ping());
    cached = { baseUrl: next.baseUrl, api: client };
    return cached.api;
  }
}

function invalidateApi(): void {
  cached = null;
  state.setConnected(false, "Kettle · disconnected");
  statusItem && (statusItem.text = "$(debug-disconnect) Kettle");
}

async function touchConnection(): Promise<boolean> {
  try {
    const a = await api();
    const p = await a.ping();
    state.setConnected(true, `Kettle · :${p.port}`);
    if (statusItem) {
      statusItem.text = `$(check) Kettle :${p.port}`;
      statusItem.tooltip = `Core pid ${p.pid} · ${cached?.baseUrl}`;
    }
    // Drop legacy "glance" model role from core settings (removed product surface).
    void stripGlanceFromCoreSettings(a);
    return true;
  } catch {
    invalidateApi();
    return false;
  }
}

/** Remove curator.models.glance / agents.glance from core settings if still present. */
async function stripGlanceFromCoreSettings(client: KettleApi): Promise<void> {
  try {
    const cur = (await client.getSettings()) as {
      curator?: { models?: Record<string, string> };
      agents?: Record<string, string>;
    };
    const models = cur.curator?.models;
    const agents = cur.agents;
    const hasGlance =
      (models && "glance" in models) || (agents && "glance" in agents);
    if (!hasGlance) return;
    const nextModels = { ...(models || {}) };
    delete nextModels.glance;
    const nextAgents = { ...(agents || {}) };
    delete nextAgents.glance;
    await client.patchSettings({
      curator: { models: nextModels },
      agents: nextAgents,
    });
  } catch {
    /* non-fatal — settings may be read-only or core older */
  }
}

function formatErr(prefix: string, e: unknown): string {
  if (e instanceof KettleApiError) return `${prefix}: ${e.message}`;
  if (e instanceof Error) return `${prefix}: ${e.message}`;
  return `${prefix}: ${String(e)}`;
}

function entryLabel(e: QueueEntry): string {
  const urg = e.urgency ? `[${e.urgency}] ` : "";
  const st = e.status && e.status !== "pending" ? ` (${e.status})` : "";
  return `${urg}${e.path}${st}`;
}

async function resolveProjectId(forcePick = false): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const configured = cfgProject();

  // Pinned setting still wins, but never silently keep a pin that doesn't
  // match the open folder (common when User-scoped leftover or wrong desk).
  if (configured && !forcePick) {
    let projectsForPin: Project[] = [];
    try {
      ({ projects: projectsForPin } = await (await api()).projects());
    } catch {
      projectsForPin = [];
    }
    const pinned = projectsForPin.find((p) => p.id === configured);
    if (pinned) {
      if (!folders.length || workspaceMatchesProject(folders, pinned.root)) {
        state.setProject(pinned);
        return pinned.id;
      }
      debug.log(
        `project pin “${configured}” does not match workspace ${folders.join(", ")}; ignoring pin`,
      );
    }
  }

  // Cached selection: only reuse if it still matches this window's folders.
  if (state.getProjectId() && !forcePick) {
    const cachedId = state.getProjectId()!;
    const cachedRoot = state.getProjectRoot();
    if (!folders.length || (cachedRoot && workspaceMatchesProject(folders, cachedRoot))) {
      return cachedId;
    }
    debug.log(
      `dropping cached project “${cachedId}” — workspace is ${folders.join(", ") || "(none)"}`,
    );
    state.setProject(undefined);
  }

  let projects;
  try {
    ({ projects } = await (await api()).projects());
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Could not list projects", e));
    return undefined;
  }
  // Infer from workspace folders when unique path match (never “sole registered”).
  // Realpath matching handles a host opening a symlink alias while the
  // registry stores the canonical directory.
  if (!forcePick && projects.length) {
    const matched = matchProjectId(projects, "", folders);
    if (matched) {
      const p = projects.find((x) => x.id === matched);
      if (p) {
        state.setProject(p);
        debug.log(
          `project matched workspace → ${p.id} (${p.root}) folders=${folders.join("|")}`,
        );
        return p.id;
      }
    } else {
      debug.log(
        `project match none for folders=[${folders.join(", ")}] ` +
          `among ${projects.map((p) => `${p.id}@${p.root}`).join("; ")}`,
      );
    }
  }

  // No projects yet — go straight to folder browser (first-run).
  if (!projects.length) {
    if (!forcePick) {
      void vscode.window.showWarningMessage(
        "No projects registered yet. Use Kettle: Register New Project (or the Desk project menu).",
      );
      return undefined;
    }
    return registerNewProject();
  }

  // No path match: do not auto-bind another project's desk. Offer picker with context.
  const folderHint =
    folders.length === 1
      ? path.basename(folders[0])
      : folders.length
        ? `${folders.length} folders`
        : "no folder";
  const pick = await vscode.window.showQuickPick(
    [
      ...projects.map((p) => {
        const matches = folders.length > 0 && workspaceMatchesProject(folders, p.root);
        return {
          // Check only for the desk already open in this window; path alone for others.
          label: matches ? `$(check) ${p.name}` : p.name,
          description: p.id,
          detail: p.root,
          project: p as typeof p | undefined,
          isAdd: false as boolean,
        };
      }),
      {
        label: "$(add) Register new project…",
        description: "browse for a folder",
        detail: "Pick any folder under your home — seeds .kettle or adopts an existing desk",
        project: undefined,
        isAdd: true,
      },
    ],
    {
      placeHolder: forcePick
        ? "Kettle project"
        : `No Kettle project matches this workspace (${folderHint}). Pick one or register a folder.`,
    },
  );
  if (!pick) return undefined;
  if (pick.isAdd) {
    return registerNewProject();
  }
  if (!pick.project) return undefined;
  return bindProject(pick.project);
}

/**
 * Host folder pick → POST /api/projects/add (or bind if already registered)
 * → bind active desk → founding interview when unfounded.
 * Shared by Desk menu, command palette, and Select Project QuickPick.
 */
async function registerNewProject(): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const defaultUri = folders[0]
    ? vscode.Uri.file(folders[0])
    : vscode.Uri.file(os.homedir());

  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Register as Kettle project",
    title: "Choose a folder to register as a Kettle desk",
    defaultUri,
  });
  const root = uris?.[0]?.fsPath;
  if (!root) return undefined;

  let projects: Project[] = [];
  try {
    ({ projects } = await (await api()).projects());
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Could not list projects", e));
    return undefined;
  }

  const existing = findProjectByRoot(projects, root);
  if (existing) {
    const id = await bindProject(existing, { skipMismatchConfirm: true });
    if (!id) return undefined;
    await afterProjectBound(id, { fromRegister: true });
    return id;
  }

  let name = nameFromRootPath(root) || path.basename(root);
  const typed = await vscode.window.showInputBox({
    prompt: "Project display name",
    value: name,
    title: "Register Kettle project",
    validateInput: (v) => (v.trim() ? undefined : "Name is required"),
  });
  if (typed == null) return undefined;
  name = typed.trim();
  if (!name) return undefined;

  let project: Project | undefined;
  try {
    const added = await (await api()).addProject({ name, root });
    project = added.project ?? {
      id: added.id,
      name: added.name,
      root: added.root,
      kit: added.kit,
    };
  } catch (e) {
    // Duplicate id: offer rename once.
    const msg = e instanceof Error ? e.message : String(e);
    if (/already|duplicate|exists/i.test(msg)) {
      const alt = await vscode.window.showInputBox({
        prompt: `Could not register (“${msg}”). Choose a different display name`,
        value: `${name} 2`,
        title: "Register Kettle project",
        validateInput: (v) => (v.trim() ? undefined : "Name is required"),
      });
      if (alt == null || !alt.trim()) return undefined;
      try {
        const added = await (await api()).addProject({ name: alt.trim(), root });
        project = added.project ?? {
          id: added.id,
          name: added.name,
          root: added.root,
          kit: added.kit,
        };
      } catch (e2) {
        invalidateApi();
        void vscode.window.showErrorMessage(formatErr("Register project failed", e2));
        return undefined;
      }
    } else {
      invalidateApi();
      void vscode.window.showErrorMessage(formatErr("Register project failed", e));
      return undefined;
    }
  }

  if (!project?.id) {
    void vscode.window.showErrorMessage("Register project failed: no project id returned.");
    return undefined;
  }

  const id = await bindProject(project, { skipMismatchConfirm: true });
  if (!id) return undefined;
  await afterProjectBound(id, { fromRegister: true });
  return id;
}

const PENDING_FOUNDING_KEY = "kettle.pendingFoundingProjectId";
/** Re-bind this project id after `vscode.openFolder` reloads the window. */
const PENDING_BIND_KEY = "kettle.pendingBindProjectId";
/**
 * After a Kettle-initiated openFolder / workspace switch, expand the
 * Explorer → Kettle queue section once. Not set on ordinary reloads.
 */
const PENDING_EXPAND_QUEUE_KEY = "kettle.pendingExpandQueueView";

/** Extension context for workspace-reload handoffs (register → openFolder). */
let extContext: vscode.ExtensionContext | undefined;

/**
 * One-shot choice from the project-switch dialog (when settings = ask).
 * Cleared after ensureProjectFolderInWorkspace runs.
 */
let pendingSwitchMode: "switchFolder" | "kettleWorkspace" | undefined;

/**
 * True after bind/ensure has started a window reload (openFolder / host CLI).
 * afterProjectBound must not run a second ensure (was fighting fleet with sole).
 */
let workspaceReloadInFlight = false;

/** Survives openFolder reload — same as pendingSwitchMode but durable. */
const PENDING_SWITCH_MODE_KEY = "kettle.pendingSwitchMode";

/** Saved multi-root workspace listing registered desks (window title: Kettle). */
function kettleFleetWorkspacePath(): string {
  return path.join(os.homedir(), ".kettle", "Kettle.code-workspace");
}

function isKettleFleetWorkspaceOpen(): boolean {
  const wf = vscode.workspace.workspaceFile;
  if (!wf || wf.scheme !== "file") return false;
  try {
    return tryRealpath(wf.fsPath) === tryRealpath(kettleFleetWorkspacePath());
  } catch {
    return path.normalize(wf.fsPath) === path.normalize(kettleFleetWorkspacePath());
  }
}

function resolveSwitchMode(): "switchFolder" | "kettleWorkspace" {
  if (pendingSwitchMode === "switchFolder" || pendingSwitchMode === "kettleWorkspace") {
    return pendingSwitchMode;
  }
  const persisted = extContext?.globalState.get<string>(PENDING_SWITCH_MODE_KEY);
  if (persisted === "switchFolder" || persisted === "kettleWorkspace") {
    return persisted;
  }
  const cfg = cfgProjectSwitchMode();
  if (cfg === "kettleWorkspace") return "kettleWorkspace";
  // cfg "ask" without a live choice → single-project (never silently open fleet)
  return "switchFolder";
}

async function setPendingSwitchMode(
  mode: "switchFolder" | "kettleWorkspace",
): Promise<void> {
  pendingSwitchMode = mode;
  await extContext?.globalState.update(PENDING_SWITCH_MODE_KEY, mode);
}

async function clearPendingSwitchMode(): Promise<void> {
  pendingSwitchMode = undefined;
  await extContext?.globalState.update(PENDING_SWITCH_MODE_KEY, undefined);
}

type WorkspaceFolderEntry = { path: string; name: string };

async function listRegisteredFolderEntries(): Promise<WorkspaceFolderEntry[]> {
  try {
    const { projects } = await (await api()).projects();
    const out: WorkspaceFolderEntry[] = [];
    const seen = new Set<string>();
    for (const p of projects) {
      const root = (p.root || "").trim();
      if (!root) continue;
      const key = tryRealpath(root);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: root,
        name: (p.name || p.id || path.basename(root)).trim() || path.basename(root),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Write ~/.kettle/Kettle.code-workspace with all registered desks (+ focus root). */
async function writeKettleFleetWorkspace(
  focusRoot: string,
): Promise<string> {
  const wsPath = kettleFleetWorkspacePath();
  await fs.mkdir(path.dirname(wsPath), { recursive: true });
  const entries = await listRegisteredFolderEntries();
  const focusKey = tryRealpath(focusRoot);
  if (focusRoot && !entries.some((e) => tryRealpath(e.path) === focusKey)) {
    entries.unshift({
      path: focusRoot,
      name: path.basename(focusRoot.replace(/\/+$/, "")) || "project",
    });
  }
  // Prefer focus project first in the list (Explorer order).
  entries.sort((a, b) => {
    const aF = tryRealpath(a.path) === focusKey ? 0 : 1;
    const bF = tryRealpath(b.path) === focusKey ? 0 : 1;
    if (aF !== bF) return aF - bF;
    return a.name.localeCompare(b.name);
  });
  const body = {
    folders: entries.map((e) => ({ path: e.path, name: e.name })),
    settings: {},
  };
  await fs.writeFile(wsPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return wsPath;
}

async function focusExplorerOnRoot(root: string): Promise<void> {
  const uri = vscode.Uri.file(root);
  try {
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand(
      "workbench.files.action.focusFilesExplorer",
    );
    await vscode.commands.executeCommand("revealInExplorer", uri);
  } catch {
    /* best-effort */
  }
}

/**
 * Multi-root “Kettle” workspace: all registered desks under one named window.
 * Always the same file: ~/.kettle/Kettle.code-workspace (never Untitled or
 * a per-project path). That path sits under ~/.kettle, which should be in the
 * host Trusted Folders list so multi-root opens without a trust prompt.
 */
async function ensureKettleFleetWorkspace(
  focusRoot: string,
): Promise<"already" | "added" | "reloading" | "failed"> {
  if (!focusRoot) return "failed";
  let wsPath: string;
  try {
    wsPath = await writeKettleFleetWorkspace(focusRoot);
  } catch (e) {
    debug.log(
      `write fleet workspace failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "failed";
  }

  // Already in the Kettle workspace: sync folder list without full reopen when possible.
  if (isKettleFleetWorkspaceOpen()) {
    if (projectRootInWorkspace(focusRoot)) {
      await focusExplorerOnRoot(focusRoot);
      return "already";
    }
    // Add missing root in place.
    try {
      const start = vscode.workspace.workspaceFolders?.length ?? 0;
      const name =
        path.basename(focusRoot.replace(/\/+$/, "")) || "project";
      const ok = vscode.workspace.updateWorkspaceFolders(start, 0, {
        uri: vscode.Uri.file(focusRoot),
        name,
      });
      if (ok) {
        await new Promise((r) => setTimeout(r, 400));
        if (projectRootInWorkspace(focusRoot)) {
          await focusExplorerOnRoot(focusRoot);
          return "added";
        }
      }
    } catch (e) {
      debug.log(
        `fleet add folder failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Leave sole-project / All-Projects windows via the same host-CLI path as
  // switchFolder (-n when multi-root or when the fleet is foreign to this desk).
  debug.logDesk("workspace.openFleet", { wsPath, focusRoot });
  const fromFolders = (vscode.workspace.workspaceFolders || []).map(
    (f) => f.uri.fsPath,
  );
  const foreignToThisWindow =
    fromFolders.length > 0 && !workspaceMatchesProject(fromFolders, focusRoot);
  const leaveMulti =
    foreignToThisWindow ||
    !!vscode.workspace.workspaceFile ||
    fromFolders.length > 1;
  if (launchHostCli(wsPath, { newWindow: leaveMulti })) {
    workspaceReloadInFlight = true;
    return "reloading";
  }
  try {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wsPath), {
      forceNewWindow: leaveMulti,
      forceReuseWindow: !leaveMulti,
    });
    workspaceReloadInFlight = true;
    return "reloading";
  } catch {
    try {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(wsPath),
        leaveMulti,
      );
      workspaceReloadInFlight = true;
      return "reloading";
    } catch (e) {
      debug.log(
        `open fleet workspace failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return "failed";
    }
  }
}

/** Host CLI (`code` / `cursor`) — more reliable than vscode.openFolder for multi-root leave. */
function hostCliBinary(): string | undefined {
  const appRoot = vscode.env.appRoot || "";
  const isCursor = /cursor/i.test(vscode.env.appName || "");
  const names = isCursor ? ["cursor", "code"] : ["code"];
  const candidates: string[] = [];
  for (const n of names) {
    if (appRoot) candidates.push(path.join(appRoot, "bin", n));
  }
  candidates.push(
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    "/usr/local/bin/code",
    "/usr/local/bin/cursor",
  );
  for (const c of candidates) {
    try {
      if (c && fssync.existsSync(c)) return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * Spawn host CLI to open a folder or .code-workspace.
 * Use -n (new window) when leaving multi-root / a .code-workspace: -r no-ops
 * if the target path is nested under an already-open parent workspace.
 */
function launchHostCli(
  targetPath: string,
  opts?: { newWindow?: boolean },
): boolean {
  const bin = hostCliBinary();
  if (!bin) {
    debug.log("workspace.hostCli: no code/cursor binary found");
    return false;
  }
  const newWindow =
    opts?.newWindow ??
    !!(
      vscode.workspace.workspaceFile ||
      (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    );
  const flag = newWindow ? "-n" : "-r";
  try {
    debug.logDesk("workspace.hostCli", { bin, flag, targetPath, newWindow });
    const child = spawn(bin, [flag, targetPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch (e) {
    debug.log(
      `workspace.hostCli failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Open a single project as its own window.
 *
 * Prefer the **project directory** (not a sidecar .code-workspace under
 * ~/.kettle). That way Workspace Trust is only about the user's desk folder —
 * the path they already registered — not a second untrusted layout file.
 * A ~/.kettle/windows/<id>.code-workspace is still written as a fallback for
 * hosts that behave better with an explicit workspace file.
 */
async function openSoleProjectWorkspace(
  root: string,
  projectId?: string,
): Promise<"reloading" | "failed"> {
  const id =
    (projectId || path.basename(root.replace(/\/+$/, "")) || "project")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 80) || "project";
  const wsDir = path.join(os.homedir(), ".kettle", "windows");
  const wsPath = path.join(wsDir, `${id}.code-workspace`);
  const name = path.basename(root.replace(/\/+$/, "")) || id;
  try {
    await fs.mkdir(wsDir, { recursive: true });
    const body = {
      folders: [{ path: root, name }],
      settings: {},
    };
    await fs.writeFile(wsPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch (e) {
    debug.log(
      `write sole workspace failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    // Still try opening the folder even if the sidecar write failed.
  }

  debug.logDesk("workspace.openSoleWorkspace", {
    root,
    wsPath,
    prefer: "folder",
    fromFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    fromWorkspaceFile: vscode.workspace.workspaceFile?.fsPath || "",
  });

  // Open a *new* window when:
  // - leaving multi-root / a .code-workspace (reuse no-ops nested paths), or
  // - this window already has folders that are a different project (registering
  //   Neogenie from an Armada sole window must not replace Armada with -r).
  const fromFolders = (vscode.workspace.workspaceFolders || []).map(
    (f) => f.uri.fsPath,
  );
  const foreignToThisWindow =
    fromFolders.length > 0 && !workspaceMatchesProject(fromFolders, root);
  const leaveMulti =
    foreignToThisWindow ||
    !!vscode.workspace.workspaceFile ||
    fromFolders.length > 1;

  // 1) Project folder first — trust = the desk the patron already chose.
  if (launchHostCli(root, { newWindow: leaveMulti })) {
    workspaceReloadInFlight = true;
    return "reloading";
  }
  // 2) Sidecar workspace file (legacy / some hosts).
  if (fssync.existsSync(wsPath) && launchHostCli(wsPath, { newWindow: leaveMulti })) {
    workspaceReloadInFlight = true;
    return "reloading";
  }

  // 3) API fallback — folder first, then workspace file.
  try {
    const folderUri = vscode.Uri.file(root);
    debug.logDesk("workspace.openFolderApi", {
      root,
      wsPath,
      forceNewWindow: leaveMulti,
      prefer: "folder",
    });
    try {
      await vscode.commands.executeCommand("vscode.openFolder", folderUri, {
        forceNewWindow: leaveMulti,
        forceReuseWindow: !leaveMulti,
      });
    } catch {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        folderUri,
        leaveMulti,
      );
    }
    workspaceReloadInFlight = true;
    return "reloading";
  } catch (e1) {
    try {
      if (fssync.existsSync(wsPath)) {
        const wsUri = vscode.Uri.file(wsPath);
        await vscode.commands.executeCommand("vscode.openFolder", wsUri, leaveMulti);
        workspaceReloadInFlight = true;
        return "reloading";
      }
    } catch (e2) {
      debug.log(
        `openSoleWorkspace failed: ${e2 instanceof Error ? e2.message : String(e2)}`,
      );
    }
    debug.log(
      `openSoleWorkspace folder failed: ${e1 instanceof Error ? e1.message : String(e1)}`,
    );
    return "failed";
  }
}

/**
 * Make sure Explorer can show this project root, using switchFolder or
 * kettleWorkspace mode (from dialog or settings).
 *
 * switchFolder opens a one-folder workspace under ~/.kettle/windows/ so VS Code
 * actually leaves multi-root parents and the current workspace.
 */
async function ensureProjectFolderInWorkspace(
  root: string,
  opts?: { projectId?: string },
): Promise<"already" | "added" | "reloading" | "failed"> {
  if (!root) return "failed";
  const mode = resolveSwitchMode();
  if (mode === "switchFolder" || mode === "kettleWorkspace") {
    pendingSwitchMode = mode;
  }

  debug.logDesk("workspace.ensure", {
    root,
    mode,
    inFleet: isKettleFleetWorkspaceOpen(),
    sole: isSoleProjectWindow(root),
    folders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    workspaceFile: vscode.workspace.workspaceFile?.fsPath || "",
  });

  if (mode === "kettleWorkspace") {
    await clearPendingSwitchMode();
    return ensureKettleFleetWorkspace(root);
  }

  // —— switchFolder only (never open fleet) ——

  if (isSoleProjectWindow(root)) {
    await clearPendingSwitchMode();
    await focusExplorerOnRoot(root);
    debug.logDesk("workspace.alreadySole", { root });
    return "already";
  }

  // Stay in Kettle fleet when picking another desk there, unless the user
  // explicitly chose "switch to the project folder" or settings force it.
  const cfg = cfgProjectSwitchMode();
  const durableMode = extContext?.globalState.get<string>(PENDING_SWITCH_MODE_KEY);
  const explicitLeaveFleet =
    cfg === "switchFolder" || durableMode === "switchFolder";
  if (
    isKettleFleetWorkspaceOpen() &&
    projectRootInWorkspace(root) &&
    !explicitLeaveFleet
  ) {
    await clearPendingSwitchMode();
    await focusExplorerOnRoot(root);
    debug.logDesk("workspace.stayInFleet", { root });
    return "already";
  }

  // Empty window: add folder in place.
  const uri = vscode.Uri.file(root);
  const name = path.basename(root.replace(/\/+$/, "")) || "project";
  const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
  if (folderCount === 0 && !vscode.workspace.workspaceFile) {
    try {
      const ok = vscode.workspace.updateWorkspaceFolders(0, 0, { uri, name });
      if (ok) {
        await new Promise((r) => setTimeout(r, 400));
        if (isSoleProjectWindow(root)) {
          await clearPendingSwitchMode();
          debug.logDesk("workspace.added", { root, mode: "empty" });
          await focusExplorerOnRoot(root);
          return "added";
        }
      }
    } catch (e) {
      debug.log(
        `updateWorkspaceFolders failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Leave multi-root / parent / fleet via a dedicated one-folder workspace file.
  const opened = await openSoleProjectWorkspace(root, opts?.projectId);
  if (opened === "failed") {
    await clearPendingSwitchMode();
  }
  return opened;
}

/** Persist bind (+ optional founding) across openFolder reload. */
async function markPendingWorkspaceHandoff(
  projectId: string,
  opts?: { founding?: boolean },
): Promise<void> {
  await extContext?.globalState.update(PENDING_BIND_KEY, projectId);
  if (opts?.founding) {
    await extContext?.globalState.update(PENDING_FOUNDING_KEY, projectId);
  }
  // New window should show Explorer → Kettle expanded (one-shot).
  await extContext?.globalState.update(PENDING_EXPAND_QUEUE_KEY, true);
}

/**
 * Expand/focus the Explorer → Kettle queue view.
 * Host auto-creates `kettle.queue.focus`; focusing expands a collapsed section.
 * Only call after a Kettle project load — not on every activation.
 */
async function expandKettleExplorerQueue(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.view.explorer");
    // Brief yield so Explorer is ready after openFolder / folder update.
    await new Promise((r) => setTimeout(r, 150));
    await vscode.commands.executeCommand("kettle.queue.focus");
    queueView?.refresh();
    debug.log("expandKettleExplorerQueue: focused kettle.queue");
  } catch (e) {
    debug.log(
      `expandKettleExplorerQueue failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Re-bind THIS window's desk to the open folder(s). Used when we open another
 * project in a *new* window — the source window must not keep the foreign
 * project id (e.g. Armada Explorer with Neogenie desk/queue).
 */
async function rebindThisWindowToOpenFolders(
  reason: string,
): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  if (!folders.length) {
    state.setProject(undefined);
    state.setEntries([]);
    deskPanel?.refresh();
    queueView?.refresh();
    debug.log(`project rebind (${reason}): no folders — cleared desk`);
    return undefined;
  }
  try {
    const { projects } = await (await api()).projects();
    const matched = matchProjectId(projects, "", folders);
    if (!matched) {
      state.setProject(undefined);
      state.setEntries([]);
      deskPanel?.refresh();
      queueView?.refresh();
      debug.log(
        `project rebind (${reason}): no match for folders=${folders.join("|")}`,
      );
      return undefined;
    }
    if (state.getProjectId() === matched) {
      return matched;
    }
    const p = projects.find((x) => x.id === matched);
    if (!p) return undefined;
    // Direct set — do not re-enter bindProject (would re-open windows).
    state.setProject(p);
    await refreshQueue();
    await refreshFoundingPhase(matched);
    deskPanel?.refresh();
    queueView?.refresh();
    debug.log(`project rebind (${reason}) → ${matched}`);
    return matched;
  } catch (e) {
    debug.log(
      `project rebind failed (${reason}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/** Refresh queue / founding after bind; open project folder when needed. */
async function afterProjectBound(
  projectId: string,
  opts?: { fromRegister?: boolean },
): Promise<void> {
  debug.logDesk("workspace.afterProjectBound", {
    projectId,
    root: state.getProjectRoot() || "",
    fromRegister: !!opts?.fromRegister,
    reloadInFlight: workspaceReloadInFlight,
  });

  // bindProject already started openFolder / host CLI — do not run a second
  // ensure (was opening sole after fleet and vice versa). Still restore this
  // window if state points at a foreign desk.
  if (workspaceReloadInFlight) {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const foreign =
      !!state.getProjectRoot() &&
      folders.length > 0 &&
      !workspaceMatchesProject(folders, state.getProjectRoot()!);
    if (foreign) {
      await rebindThisWindowToOpenFolders("afterProjectBound-reloadInFlight");
    }
    return;
  }

  // Switch workspace FIRST. refreshQueue can hang on a slow core and used to
  // block openFolder entirely (logs showed switchChoice then nothing).
  const root = state.getProjectRoot();
  if (root) {
    // Handoff flags before any reload so they survive even if openFolder
    // tears down the extension mid-await.
    const phaseHint = state.getFoundingPhase();
    const wantFounding =
      !!opts?.fromRegister &&
      (phaseHint === "none" || phaseHint === "interviewing");
    await markPendingWorkspaceHandoff(projectId, { founding: wantFounding });

    let ensured: "already" | "added" | "reloading" | "failed" = "failed";
    try {
      ensured = await ensureProjectFolderInWorkspace(root, { projectId });
    } catch (e) {
      debug.log(
        `ensureProjectFolderInWorkspace threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      ensured = "failed";
    }
    debug.logDesk("workspace.afterEnsure", { projectId, root, ensured });

    if (ensured === "reloading") {
      workspaceReloadInFlight = true;
      // Register / skipMismatchConfirm path: bind sets the foreign project then
      // opens it in another window (cursor -n). This window must not keep that
      // desk (Armada Explorer + Neogenie queue). Handoff keys stay for the
      // destination window.
      const foldersHere = (vscode.workspace.workspaceFolders || []).map(
        (f) => f.uri.fsPath,
      );
      const foreignHere =
        !!root &&
        foldersHere.length > 0 &&
        !workspaceMatchesProject(foldersHere, root);
      if (foreignHere) {
        await rebindThisWindowToOpenFolders("afterProjectBound-foreign-reloading");
      }
      return;
    }
    // Stayed in-window: clear premature handoff flags.
    await extContext?.globalState.update(PENDING_BIND_KEY, undefined);
    await extContext?.globalState.update(PENDING_FOUNDING_KEY, undefined);
    await extContext?.globalState.update(PENDING_EXPAND_QUEUE_KEY, undefined);

    if (ensured === "failed") {
      void vscode.window.showWarningMessage(
        `Could not open ${root} in this window — Explorer may stay empty. ` +
          `File → Open Folder to that project, then continue.`,
      );
    } else {
      await expandKettleExplorerQueue();
    }
  }

  try {
    await refreshQueue();
    await refreshFoundingPhase(projectId);
  } catch (e) {
    debug.log(
      `afterProjectBound refresh failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  deskPanel?.refresh();
  queueView?.refresh();

  const phase = state.getFoundingPhase();
  if (phase === "none" || phase === "interviewing") {
    if (opts?.fromRegister && phase === "none") {
      await beginFounding();
      return;
    }
    if (phase === "interviewing") {
      await vscode.commands.executeCommand("kettle.deskPanel.focus");
    }
  }
}

/** Desk / host: project rows for the in-panel dropdown. */
export type DeskProjectOption = {
  id: string;
  name: string;
  root: string;
  /** True when this project's root matches the open workspace folder(s). */
  matches: boolean;
};

async function listProjectsForDesk(): Promise<DeskProjectOption[]> {
  try {
    const { projects } = await (await api()).projects();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    return projects.map((p) => ({
      id: p.id,
      name: (p.name || p.id).trim() || p.id,
      root: p.root,
      matches: folders.length > 0 && workspaceMatchesProject(folders, p.root),
    }));
  } catch {
    invalidateApi();
    return [];
  }
}

/**
 * Models for the Desk pill — every catalog model for providers whose CLI is on PATH.
 * (Not limited to the three Claude “menu” checkmarks in `visible`.)
 */
async function listModelsForDesk(): Promise<{
  models: { id: string; label: string; provider: string }[];
  activeId: string;
}> {
  const cat = await (await api()).curatorCatalog();
  const active =
    cat.active?.models?.chat ||
    (cat.active as { chat?: string } | undefined)?.chat ||
    "";
  const activeProvider = cat.active?.provider || "";

  // Ready providers: command exists (or cli custom always listed if present).
  const ready = new Set(
    ((cat as { providers?: { id: string; command_exists?: boolean }[] }).providers || [])
      .filter((p) => p.command_exists !== false)
      .map((p) => p.id),
  );
  // If catalog omits providers[], fall back to every provider that has models.
  const byProv =
    (cat as { models_by_provider?: Record<string, string[]> }).models_by_provider ||
    {};
  if (!ready.size) {
    for (const p of Object.keys(byProv)) ready.add(p);
  }

  const labelByKey = new Map<string, string>();
  for (const m of cat.models || []) {
    labelByKey.set(`${m.provider}/${m.id}`, m.label || m.id);
  }
  // visible may have richer labels
  for (const m of cat.visible || []) {
    labelByKey.set(`${m.provider}/${m.id}`, m.label || m.id);
  }

  const models: { id: string; label: string; provider: string }[] = [];
  const seen = new Set<string>();

  const push = (id: string, provider: string, label?: string) => {
    const key = `${provider}/${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push({
      id,
      provider,
      label: label || labelByKey.get(key) || id,
    });
  };

  // Prefer explicit models_by_provider for ready CLIs (claude, grok, gemini, …).
  for (const [provider, ids] of Object.entries(byProv)) {
    if (!ready.has(provider)) continue;
    for (const id of ids) push(id, provider);
  }
  // Full catalog entries for ready providers not already covered.
  for (const m of cat.models || []) {
    if (!ready.has(m.provider)) continue;
    push(m.id, m.provider, m.label);
  }
  // Always include the active chat model even if its CLI was marked missing.
  if (active) {
    push(active, activeProvider || "claude");
  }

  // Stable sort: active provider first, then provider name, then label.
  models.sort((a, b) => {
    const ap = a.provider === activeProvider ? 0 : 1;
    const bp = b.provider === activeProvider ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return (a.label || a.id).localeCompare(b.label || b.id);
  });

  return { models, activeId: active };
}

/** Bind a registered project (shared by QuickPick and Desk dropdown). */
async function bindProject(
  project: Project,
  opts?: { skipMismatchConfirm?: boolean },
): Promise<string | undefined> {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const rootMismatch =
    !!project.root &&
    folders.length > 0 &&
    !workspaceMatchesProject(folders, project.root);
  // Also treat "in fleet workspace but settings want switch" as needing ensure only — no dialog.

  if (!opts?.skipMismatchConfirm && rootMismatch) {
    const label = (project.name || project.id).trim() || project.id;
    const mode = cfgProjectSwitchMode();

    if (mode === "ask") {
      // QuickPick: host modal has no real bold hierarchy. Match mode by label
      // (some hosts strip custom QuickPickItem fields).
      const SWITCH_LABEL = "Switch to the project folder";
      const FLEET_LABEL = "Load the project to a shared workspace";
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: SWITCH_LABEL,
            detail:
              "Opens only this project (new window when leaving a multi-root workspace like All-Projects).",
          },
          {
            label: FLEET_LABEL,
            detail:
              "Multi-root explorer keeps your registered Kettle desks together " +
              "(can get heavy with several large repos; sometimes confuses git).",
          },
        ],
        {
          title: `The “${label}” project lives outside the current workspace.`,
          placeHolder:
            "How should the file explorer handle this project?  ·  change default later in Settings → Kettle → Project Switch Mode",
          ignoreFocusOut: true,
          matchOnDetail: true,
        },
      );
      if (!pick) return undefined;
      const chosen: "switchFolder" | "kettleWorkspace" =
        pick.label === FLEET_LABEL ? "kettleWorkspace" : "switchFolder";
      await setPendingSwitchMode(chosen);
      debug.logDesk("workspace.switchChoice", { projectId: project.id, chosen });
    } else if (mode === "kettleWorkspace") {
      await setPendingSwitchMode("kettleWorkspace");
    } else {
      await setPendingSwitchMode("switchFolder");
    }
  }

  const foldersNow = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const opensElsewhere =
    !!project.root &&
    foldersNow.length > 0 &&
    !workspaceMatchesProject(foldersNow, project.root) &&
    !isSoleProjectWindow(project.root);

  // Set so afterProjectBound / ensure can read root. If this desk opens in
  // another window, rebind restores the folder match (below and in
  // afterProjectBound) so Armada never keeps a Neogenie bind.
  state.setProject(project);
  debug.logDesk("workspace.bindSet", {
    projectId: project.id,
    root: project.root || "",
    pendingMode: pendingSwitchMode || "",
    opensElsewhere,
    skipMismatchConfirm: !!opts?.skipMismatchConfirm,
  });

  // Open HERE for normal project-switch (dialog path). Register uses
  // skipMismatchConfirm and opens via afterProjectBound (founding handoff).
  // Logs showed switchChoice with no afterProjectBound — so ensure stays in
  // bind for the dialog path.
  if (
    !opts?.skipMismatchConfirm &&
    project.root &&
    !isSoleProjectWindow(project.root)
  ) {
    try {
      await markPendingWorkspaceHandoff(project.id, {});
      const ensured = await ensureProjectFolderInWorkspace(project.root, {
        projectId: project.id,
      });
      debug.logDesk("workspace.bindEnsure", {
        projectId: project.id,
        ensured,
        opensElsewhere,
      });
      if (ensured === "reloading") {
        workspaceReloadInFlight = true;
        // New window for a foreign project (cursor -n): restore this window's
        // desk to the open folders (e.g. Armada stays Armada).
        if (opensElsewhere) {
          await rebindThisWindowToOpenFolders("foreign-project-new-window");
        }
        return project.id;
      }
      // Stayed in-window — clear premature handoff.
      await extContext?.globalState.update(PENDING_BIND_KEY, undefined);
      await extContext?.globalState.update(PENDING_FOUNDING_KEY, undefined);
      await extContext?.globalState.update(PENDING_EXPAND_QUEUE_KEY, undefined);
    } catch (e) {
      debug.log(
        `bindProject ensure threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      if (opensElsewhere) {
        await rebindThisWindowToOpenFolders("foreign-project-ensure-error");
      }
    }
  }

  return project.id;
}

/**
 * Ensure the canonical Kettle data dir + fleet workspace file exist.
 *
 * Workspace Trust is host-owned (extensions cannot grant it). We:
 * - keep stable paths under ~/.kettle for multi-desk layouts
 * - prefer opening the *project folder* for sole-desk mode (trust = desk root)
 * - when this window is untrusted and uses Kettle layout files, explain once
 *   how to trust ~/.kettle without disabling Workspace Trust
 */
async function ensureKettleWorkspaceLayout(): Promise<void> {
  const kettleDir = path.join(os.homedir(), ".kettle");
  const windowsDir = path.join(kettleDir, "windows");
  try {
    await fs.mkdir(windowsDir, { recursive: true });
  } catch (e) {
    debug.log(
      `ensureKettleWorkspaceLayout mkdir: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Seed empty fleet file if missing so the path is always the same URI to trust.
  const fleet = kettleFleetWorkspacePath();
  try {
    await fs.access(fleet);
  } catch {
    try {
      const body = { folders: [] as { path: string; name: string }[], settings: {} };
      await fs.writeFile(fleet, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      debug.logDesk("workspace.seededFleet", { fleet });
    } catch (e) {
      debug.log(
        `seed fleet workspace failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // One-time product tip (even when trusted): multi-desk needs ~/.kettle trusted.
  const tipKey = "kettle.trustTip.sharedWorkspace";
  if (extContext && !extContext.globalState.get(tipKey)) {
    // Defer so we don't stack with other activate toasts.
    setTimeout(() => {
      void (async () => {
        if (!extContext || extContext.globalState.get(tipKey)) return;
        await extContext.globalState.update(tipKey, true);
        const pick = await vscode.window.showInformationMessage(
          "Kettle tip: sole projects open as the project folder (trust that folder). " +
            "Shared multi-desk mode uses ~/.kettle/Kettle.code-workspace — " +
            "add ~/.kettle once under Workspaces: Manage Workspace Trust " +
            "(do not turn Workspace Trust off).",
          "Manage Workspace Trust",
          "Got it",
        );
        if (pick === "Manage Workspace Trust") {
          void vscode.commands.executeCommand("workbench.trust.manage");
        }
      })();
    }, 2500);
  }

  // If this window is already a Kettle layout and Restricted Mode is on, nudge.
  // Extensions cannot grant trust (by design).
  const wf = vscode.workspace.workspaceFile?.fsPath || "";
  const underKettleData =
    isKettleFleetWorkspaceOpen() ||
    (wf &&
      (wf.startsWith(kettleDir + path.sep) ||
        tryRealpath(wf).startsWith(tryRealpath(kettleDir) + path.sep)));
  if (
    underKettleData &&
    typeof vscode.workspace.isTrusted === "boolean" &&
    !vscode.workspace.isTrusted
  ) {
    const key = "kettle.trustNudge.kettleDir";
    if (!extContext?.globalState.get(key)) {
      await extContext?.globalState.update(key, true);
      void vscode.window
        .showWarningMessage(
          "This Kettle window is in Restricted Mode. " +
            "Trust ~/.kettle (shared multi-desk layouts) and your project folders " +
            "under Workspaces: Manage Workspace Trust — keep Workspace Trust enabled.",
          "Manage Workspace Trust",
        )
        .then((pick) => {
          if (pick === "Manage Workspace Trust") {
            void vscode.commands.executeCommand("workbench.trust.manage");
          }
        });
    }
  }
}

async function bindProjectById(projectId: string): Promise<string | undefined> {
  const id = projectId.trim();
  if (!id) return undefined;
  try {
    const { projects } = await (await api()).projects();
    const p = projects.find((x) => x.id === id);
    if (!p) {
      void vscode.window.showWarningMessage(`Unknown Kettle project: ${id}`);
      return undefined;
    }
    return bindProject(p);
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Could not bind project", e));
    return undefined;
  }
}

async function ensureProjectRoot(projectId: string): Promise<string | undefined> {
  if (state.getProjectId() === projectId && state.getProjectRoot()) {
    return state.getProjectRoot();
  }
  try {
    const { projects } = await (await api()).projects();
    const p = projects.find((x) => x.id === projectId);
    if (p) {
      state.setProject(p);
      return p.root;
    }
  } catch {
    /* ignore */
  }
  return state.getProjectRoot();
}

async function refreshFoundingPhase(projectId: string): Promise<void> {
  try {
    const iv = await (await api()).interviewStatus(projectId, { mutate: false });
    const founded =
      iv.status === "founded" || !!iv.has_entries || (iv.entry_count ?? 0) > 0;
    if (founded) {
      state.setFoundingPhase("founded");
    } else if (iv.status === "proposing" || iv.has_proposal) {
      state.setFoundingPhase("proposing");
    } else if (iv.status === "interviewing") {
      state.setFoundingPhase("interviewing");
    } else {
      state.setFoundingPhase("none");
    }
  } catch {
    /* leave phase unchanged on soft failure */
  }
}

async function refreshQueue(): Promise<void> {
  const projectId = state.getProjectId() || (await resolveProjectId());
  if (!projectId) return;
  try {
    const q = await (await api()).queue(projectId, { mutate: false });
    state.setEntries(q.entries || []);
    await refreshFoundingPhase(projectId);
    deskPanel?.refresh();
    queueView?.refresh();
    updateEditorContext();
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Could not load queue", e));
  }
}

/** Queue entry for the active editor file, if any. */
function entryForActiveEditor(): QueueEntry | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") return undefined;
  return findEntryForEditorPath(
    ed.document.uri.fsPath,
    state.getEntries(),
    state.getProjectRoot(),
  );
}

/**
 * Context keys for menus / keybindings:
 * - kettle.hasProject — a project is bound
 * - kettle.editorOnQueue — active file is a queue entry
 * - kettle.editorPending — that entry is not yet approved
 */
function updateEditorContext(): void {
  const projectId = state.getProjectId();
  const hit = entryForActiveEditor();
  const pending = !!(hit && !isApprovedEntry(hit));
  void vscode.commands.executeCommand("setContext", "kettle.hasProject", !!projectId);
  void vscode.commands.executeCommand("setContext", "kettle.editorOnQueue", !!hit);
  void vscode.commands.executeCommand("setContext", "kettle.editorPending", pending);
  if (hit) state.setLastEntry(hit);
}

/** Prefer active editor entry, then last desk selection, then QuickPick. */
async function resolveEntryForAction(opts?: {
  pendingOnly?: boolean;
}): Promise<QueueEntry | undefined> {
  const projectId = await resolveProjectId();
  if (!projectId) return undefined;

  const fromEditor = entryForActiveEditor();
  if (fromEditor && (!opts?.pendingOnly || !isApprovedEntry(fromEditor))) {
    state.setLastEntry(fromEditor);
    return fromEditor;
  }

  const last = state.getLastEntry();
  if (last && (!opts?.pendingOnly || !isApprovedEntry(last))) {
    return last;
  }

  return pickEntry(
    projectId,
    opts?.pendingOnly ? (e) => !isApprovedEntry(e) : undefined,
  );
}

async function beginFounding(): Promise<void> {
  const projectId = state.getProjectId() || (await resolveProjectId());
  if (!projectId) {
    void vscode.window.showWarningMessage("Select a Kettle project first.");
    return;
  }
  // Founding without a loaded Explorer is a dead end for watching desk files.
  const root =
    state.getProjectRoot() || (await ensureProjectRoot(projectId));
  if (root) {
    const ensured = await ensureProjectFolderInWorkspace(root);
    if (ensured === "reloading") {
      await markPendingWorkspaceHandoff(projectId, { founding: true });
      return;
    }
  }
  debug.logDesk("interview.start", { projectId });
  state.setFoundingPhase("interviewing");
  deskPanel?.startFoundingKickoff();
  deskPanel?.refresh();
  // Expand `.kettle` in Explorer first (Cursor only selects the folder unless
  // we expand + reveal a leaf). Then focus Desk; autofocus is suppressed briefly.
  try {
    await revealKettleDeskFolder({ force: true });
  } catch {
    /* best-effort */
  }
  await vscode.commands.executeCommand("kettle.deskPanel.focus");
  try {
    await deskPanel?.runFoundingInterview("");
    await refreshFoundingPhase(projectId);
    deskPanel?.refresh();
    debug.logDesk("interview.end", { projectId, phase: state.getFoundingPhase() });
  } catch (e) {
    debug.logDesk("interview.error", e instanceof Error ? e.message : String(e));
    deskPanel?.endFoundingFreeze();
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Founding interview failed", e));
  }
}

async function pickEntry(
  projectId: string,
  filter?: (e: QueueEntry) => boolean,
): Promise<QueueEntry | undefined> {
  let entries = state.getEntries();
  if (!entries.length) {
    try {
      const q = await (await api()).queue(projectId, { mutate: false });
      entries = q.entries || [];
      state.setEntries(entries);
    } catch (e) {
      invalidateApi();
      void vscode.window.showErrorMessage(formatErr("Could not load queue", e));
      return undefined;
    }
  }
  if (filter) entries = entries.filter(filter);
  if (!entries.length) {
    void vscode.window.showInformationMessage("Queue is empty for this project.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    entries.map((e) => ({
      label: entryLabel(e),
      description: String(e.id),
      detail: e.ask || e.brief?.slice(0, 120),
      entry: e,
    })),
    { placeHolder: "Queue entry" },
  );
  return pick?.entry;
}

/**
 * After a click in the Kettle queue, ignore editor→queue reveals briefly so a
 * still-open previous tab does not re-highlight the old row (dual selection).
 */
let suppressEditorRevealUntil = 0;
let queueClickEntryId: string | undefined;

async function openEntry(
  entry: QueueEntry,
  opts?: { fromQueueClick?: boolean },
): Promise<void> {
  const projectId = state.getProjectId() || (await resolveProjectId());
  if (!projectId) return;
  const root = (await ensureProjectRoot(projectId)) || state.getProjectRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Unknown project root.");
    return;
  }
  if (opts?.fromQueueClick) {
    suppressEditorRevealUntil = Date.now() + 600;
    queueClickEntryId = String(entry.id);
  }
  const abs = entryAbsPath(entry, root);
  const uri = vscode.Uri.file(abs);
  try {
    // Desk first so the sitting tracks the queue click even if the editor is slow.
    state.setLastEntry(entry);
    deskPanel?.refresh();
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    updateEditorContext();
  } catch (e) {
    void vscode.window.showErrorMessage(formatErr(`Could not open ${abs}`, e));
  }
}

/** Throttle Explorer re-expands of `.kettle` during founding (ms). */
let lastDeskRevealAt = 0;
/**
 * While > now, skip auto-focusing the Desk secondary bar so Explorer can
 * stay selected after a founding reveal (Cursor steals focus easily).
 */
let suppressDeskAutofocusUntil = 0;

function projectRootInWorkspace(root: string): boolean {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return false;
  const n = tryRealpath(root);
  return folders.some((f) => {
    const base = tryRealpath(f.uri.fsPath);
    return n === base || n.startsWith(base + path.sep);
  });
}

/**
 * True when this window is already a single-folder workspace rooted exactly
 * at `root` (not a broader parent workspace, and not the
 * multi-desk Kettle fleet). One-folder files under ~/.kettle/windows/ count.
 */
function isSoleProjectWindow(root: string): boolean {
  if (!root) return false;
  if (isKettleFleetWorkspaceOpen()) return false;
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length !== 1) return false;
  return tryRealpath(folders[0].uri.fsPath) === tryRealpath(root);
}

/** Generation counter so stacked delayed expands cancel when a newer reveal runs. */
let deskRevealGen = 0;

/**
 * Expand the project's `.kettle` folder in the host Explorer.
 *
 * Goal: open the twisty so founding writes are visible — not to select a file.
 * The built-in Explorer has no public “expand without select” API, so we:
 *   1. revealInExplorer(`.kettle`)  — focuses the folder (not a leaf)
 *   2. list.expand                    — opens the twisty on the selection
 *
 * We deliberately do **not** reveal runtime/session.json or other leaves
 * (that was selecting random files and fighting the user). Callers that need
 * a file open should use openTextDocument / showTextDocument themselves.
 */
async function revealKettleDeskFolder(opts?: {
  /** @deprecated Ignored — expand is folder-only. Kept for call-site compat. */
  path?: string;
  force?: boolean;
}): Promise<void> {
  let root = state.getProjectRoot();
  if (!root) {
    const pid = state.getProjectId();
    if (pid) root = await ensureProjectRoot(pid);
  }
  if (!root) {
    debug.log("desk.reveal skipped: no project root");
    return;
  }
  // Explorer only shows workspace folders — load the project if needed.
  if (!projectRootInWorkspace(root)) {
    const ensured = await ensureProjectFolderInWorkspace(root);
    if (ensured === "reloading" || ensured === "failed") {
      debug.log(`desk.reveal: workspace ensure → ${ensured}`);
      if (ensured === "failed") return;
      return;
    }
  }

  const desk = kettleDeskDir(root);
  const now = Date.now();
  if (!opts?.force && now - lastDeskRevealAt < 2000) {
    return;
  }
  lastDeskRevealAt = now;
  // Hold Desk autofocus so primary Explorer stays visible (esp. Cursor).
  suppressDeskAutofocusUntil = now + 12_000;

  try {
    await fs.mkdir(desk, { recursive: true });
  } catch {
    /* may already exist */
  }

  const deskUri = vscode.Uri.file(desk);
  const gen = ++deskRevealGen;

  const expandDeskOnly = async (): Promise<void> => {
    if (gen !== deskRevealGen) return;
    // Bring Explorer forward once — no editor open, no leaf selection.
    for (const cmd of [
      "workbench.view.explorer",
      "workbench.files.action.focusFilesExplorer",
    ]) {
      try {
        await vscode.commands.executeCommand(cmd);
      } catch {
        /* host may lack a command */
      }
    }
    try {
      await vscode.commands.executeCommand("revealInExplorer", deskUri);
    } catch {
      /* continue */
    }
    // Expand the selected folder row. Do not list.expandSelectionDown (moves
    // selection into children) and do not reveal a child file.
    try {
      await vscode.commands.executeCommand("list.expand");
    } catch {
      /* not every host */
    }
  };

  try {
    await expandDeskOnly();
    // One settle retry for Cursor — cancelable if a newer reveal runs.
    setTimeout(() => {
      void expandDeskOnly();
    }, 450);

    debug.logDesk("desk.reveal", {
      desk,
      mode: "expand-folder-only",
      inWorkspace: projectRootInWorkspace(root),
    });
  } catch (e) {
    debug.log(
      `desk.reveal failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Wait until DESK-PROPOSAL.md exists on disk (propose stream can finish before flush). */
async function waitForProposalFile(
  abs: string,
  opts?: { tries?: number; delayMs?: number },
): Promise<boolean> {
  const tries = opts?.tries ?? 20;
  const delayMs = opts?.delayMs ?? 150;
  for (let i = 0; i < tries; i++) {
    try {
      await fs.access(abs);
      const st = await fs.stat(abs);
      if (st.isFile() && st.size > 0) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** After /api/propose: focus DESK-PROPOSAL.md and select its queue entry for Approve. */
async function openDraftedProposal(projectId: string): Promise<void> {
  const root = (await ensureProjectRoot(projectId)) || state.getProjectRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Could not open Desk Proposal: no project root.");
    return;
  }

  // Refresh queue so the proposal entry is available when core just created it.
  try {
    const q = await (await api()).queue(projectId, { mutate: true });
    state.setEntries(q.entries || []);
    await refreshFoundingPhase(projectId);
  } catch {
    /* still try opening the well-known path */
  }

  const entries = state.getEntries();
  const entry = entries.find(isProposalEntry) || null;
  const abs = entry
    ? entryAbsPath(entry, root)
    : path.join(root, ".kettle", "DESK-PROPOSAL.md");
  const uri = vscode.Uri.file(abs);

  const ready = await waitForProposalFile(abs);
  if (!ready) {
    const msg = `Desk Proposal not found yet at ${abs}`;
    debug.log(msg);
    void vscode.window.showWarningMessage(
      `${msg}. It may still be writing — try opening .kettle/DESK-PROPOSAL.md from Explorer.`,
    );
    // Expand .kettle so the file is visible when it lands (folder only).
    try {
      await revealKettleDeskFolder({ force: true });
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    if (entry) {
      state.setLastEntry(entry);
      deskPanel?.refresh();
      queueView?.refresh();
    }
    // Expand `.kettle`, then open the proposal in the editor (host autoReveal
    // may highlight the file — that's intentional when we open it).
    try {
      await revealKettleDeskFolder({ force: true });
    } catch {
      /* ignore */
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    // Re-assert focus after webview message loop (Cursor steals back to Desk).
    setTimeout(() => {
      void vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
    }, 250);
    setTimeout(() => {
      void vscode.window.showTextDocument(doc, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
    }, 800);
    updateEditorContext();
    debug.logDesk("proposal.opened", {
      projectId,
      path: abs,
      fromEntry: !!entry,
      bytes: (await fs.stat(abs)).size,
    });
  } catch (e) {
    const msg = formatErr(`Could not open Desk Proposal at ${abs}`, e);
    debug.log(msg);
    void vscode.window.showErrorMessage(msg);
  }
}

/** Modal gate before a sweep, honoring kettle.confirmSweep. True = proceed. */
async function confirmSweep(projectId: string): Promise<boolean> {
  if (!cfgConfirmSweep()) return true;
  const ok = await vscode.window.showWarningMessage(
    `Sweep project “${projectId}”? This is the commit pass (diff → assess → ripple → learn), not approve.`,
    { modal: true },
    "Sweep",
  );
  return ok === "Sweep";
}

/** Gear → Kettle settings in this editor (no web-UI detour). */
async function openSettingsMenu(): Promise<void> {
  void vscode.commands.executeCommand("workbench.action.openSettings", "kettle");
}

/**
 * Save exactly the resolved DESK-PROPOSAL.md editor buffer before founding.
 * No other dirty document is touched. False means approve/found must abort.
 */
async function saveDirtyProposalDocument(
  entry: QueueEntry,
  projectId: string,
): Promise<boolean> {
  const root = (await ensureProjectRoot(projectId)) || state.getProjectRoot();
  const abs = root ? proposalDocumentPath(entry, root) : undefined;
  if (!abs) {
    void vscode.window.showErrorMessage(
      "Found Desk stopped: could not resolve DESK-PROPOSAL.md.",
    );
    return false;
  }

  try {
    const resolved = tryRealpath(abs);
    const doc =
      vscode.workspace.textDocuments.find(
        (candidate) =>
          candidate.uri.scheme === "file" &&
          tryRealpath(candidate.uri.fsPath) === resolved,
      ) || (await vscode.workspace.openTextDocument(vscode.Uri.file(abs)));
    if (!doc.isDirty) return true;
    if (await doc.save()) return true;
    void vscode.window.showErrorMessage(
      "Found Desk stopped: DESK-PROPOSAL.md could not be saved.",
    );
    return false;
  } catch (error) {
    void vscode.window.showErrorMessage(
      formatErr("Found Desk stopped: could not save DESK-PROPOSAL.md", error),
    );
    return false;
  }
}

/** True while an auto-sweep triggered by kettle.autoSweepOnQueueDone is in flight. */
let autoSweepInFlight = false;

/**
 * kettle.autoSweepOnQueueDone — once every queue entry is approved/rework (none
 * left pending), run Sweep automatically instead of waiting for a manual click.
 * Reuses the kettle.sweep command so kettle.confirmSweep still gates it.
 */
async function maybeAutoSweepOnQueueDone(): Promise<void> {
  if (!cfgAutoSweepOnQueueDone() || autoSweepInFlight) return;
  const entries = state.getEntries();
  if (!entries.length) return;
  const allResolved = entries.every((e) => e.status === "approved" || e.status === "rework");
  if (!allResolved) return;
  autoSweepInFlight = true;
  try {
    await vscode.commands.executeCommand("kettle.sweep");
  } finally {
    autoSweepInFlight = false;
  }
}

async function approveEntry(entry: QueueEntry): Promise<void> {
  const projectId = state.getProjectId() || (await resolveProjectId());
  if (!projectId) return;
  const proposal = proposalEntryForFounding(
    state.getEntries(),
    entry,
    state.isProposing(),
  );
  if (state.isProposing() && !proposal) {
    void vscode.window.showErrorMessage(
      "Found Desk stopped: the DESK-PROPOSAL.md queue entry is missing.",
    );
    return;
  }
  const target = proposal || entry;
  const wasProposal = !!proposal;
  if (!(await confirmApprove(target.path, { foundingProposal: wasProposal }))) return;
  if (wasProposal && !(await saveDirtyProposalDocument(target, projectId))) return;
  try {
    const approvedId = target.id;
    await (await api()).approve(projectId, target.id);
    // Desk Proposal: approve bookmarks, then curator digests edits + first batch.
    if (wasProposal) {
      await foundFromProposal(projectId);
      return;
    }
    await refreshQueue();
    void maybeAutoSweepOnQueueDone();
    // Queue view re-sorts: approved last, muted/strikethrough via decorations.
    if (cfgOpenNextOnApprove()) {
      const next = nextPendingEntry(state.getEntries(), approvedId);
      if (next) {
        await openEntry(next);
        await queueView?.revealEntry(next);
      } else {
        const fresh = state.getEntries().find((e) => String(e.id) === String(approvedId));
        if (fresh) state.setLastEntry(fresh);
        deskPanel?.refresh();
        void vscode.window.showInformationMessage(
          "Approved — no more pending entries. Sweep when the sitting is done.",
        );
      }
    } else {
      const fresh = state.getEntries().find((e) => String(e.id) === String(approvedId));
      if (fresh) state.setLastEntry(fresh);
      deskPanel?.refresh();
      void vscode.window.showInformationMessage(
        `Approved (ruling bookmarked; run Sweep when the sitting is done).`,
      );
    }
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Approve failed", e));
  }
}

/** After proposal approve: POST /api/found, stream into Desk, restock queue. */
async function foundFromProposal(projectId: string): Promise<void> {
  await vscode.commands.executeCommand("kettle.deskPanel.focus");
  // Expand `.kettle` so founding writes (PROJECT.md, MEMORY, queue…) are visible.
  try {
    await revealKettleDeskFolder({ force: true });
  } catch {
    /* best-effort */
  }
  try {
    if (deskPanel) {
      await deskPanel.runHostStream("found", async (onEvent) => {
        await (await api()).found(projectId, { onEvent });
      });
    } else {
      await (await api()).found(projectId);
    }
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Found Desk failed", e));
    return;
  }
  state.setFoundingPhase("none");
  await refreshQueue();
  const first = state
    .getEntries()
    .find((e) => !isApprovedEntry(e) && !isProposalEntry(e));
  if (first) await openEntry(first);
  void vscode.window.showInformationMessage(
    "Desk founded — first queue batch is ready.",
  );
}

/** Return false without posting /api/compact when core says no session exists. */
async function compactProject(
  projectId: string,
  opts?: {
    onEvent?: (event: StreamEvent) => void;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const client = await api();
  const interview = await client.interviewStatus(projectId, { mutate: false });
  if (!shouldPostCompact(interview)) return false;
  await client.compact(projectId, opts);
  return true;
}

async function commentEntry(entry: QueueEntry, text: string): Promise<void> {
  const projectId = state.getProjectId() || (await resolveProjectId());
  if (!projectId) return;
  try {
    await (await api()).comment(projectId, entry.id, text);
    await refreshQueue();
    // keep selection with updated comment
    const fresh = state.getEntries().find((e) => String(e.id) === String(entry.id));
    if (fresh) state.setLastEntry(fresh);
    deskPanel?.refresh();
  } catch (e) {
    invalidateApi();
    void vscode.window.showErrorMessage(formatErr("Comment failed", e));
  }
}

async function jumpToActiveEditorEntry(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") {
    void vscode.window.showInformationMessage("No active file editor.");
    return;
  }
  const projectId = state.getProjectId() || (await resolveProjectId());
  if (!projectId) return;
  if (!state.getEntries().length) await refreshQueue();
  const hit = findEntryForEditorPath(
    ed.document.uri.fsPath,
    state.getEntries(),
    state.getProjectRoot(),
  );
  if (!hit) {
    void vscode.window.showInformationMessage(
      "Active file is not on the Kettle queue for this project.",
    );
    return;
  }
  state.setLastEntry(hit);
  deskPanel?.refresh();
  // Reveal desk panel
  await vscode.commands.executeCommand("kettle.deskPanel.focus");
}

async function refreshDiffForEntry(entry: QueueEntry): Promise<QueueEntry> {
  const projectId = state.getProjectId();
  if (!projectId) return entry;
  try {
    const { stat } = await (await api()).diffstat(projectId, entry.id);
    const next = { ...entry, diff: stat };
    // also patch in entries cache
    const entries = state.getEntries().map((e) =>
      String(e.id) === String(entry.id) ? next : e,
    );
    state.setEntries(entries);
    state.setLastEntry(next);
    return next;
  } catch (e) {
    void vscode.window.showErrorMessage(formatErr("Diffstat failed", e));
    return entry;
  }
}

/**
 * After VS Code saves a file that is on the queue, refresh diff badges and
 * optionally record user lineage via core /api/save (content already on disk).
 */
async function onDidSaveDocument(doc: vscode.TextDocument): Promise<void> {
  if (doc.uri.scheme !== "file") return;
  const projectId = state.getProjectId();
  const root = state.getProjectRoot();
  if (!projectId || !root) return;
  let entries = state.getEntries();
  if (!entries.length) {
    try {
      const q = await (await api()).queue(projectId, { mutate: false });
      entries = q.entries || [];
      state.setEntries(entries);
    } catch {
      return;
    }
  }
  const hit = findEntryForEditorPath(doc.uri.fsPath, entries, root);
  if (!hit) return;

  try {
    // Lineage-aware save through core (writes same content; logs user edit)
    await (await api()).save(doc.uri.fsPath, doc.getText(), projectId);
  } catch {
    // Non-fatal — file is already saved by VS Code
  }

  const fresh = await refreshDiffForEntry(hit);
  if (state.getLastEntry() && String(state.getLastEntry()!.id) === String(hit.id)) {
    state.setLastEntry(fresh);
    deskPanel?.refresh();
  }
}

/**
 * If the active editor file is on the Kettle queue, make it Kettle's
 * active entry: Desk brief + **TreeView selection highlight** (same as a click).
 */
async function syncActiveFileToKettle(reason: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") {
    updateEditorContext();
    return;
  }
  const fsPath = ed.document.uri.fsPath;

  let projectId = state.getProjectId();
  if (!projectId) {
    try {
      projectId = await resolveProjectId();
    } catch {
      projectId = undefined;
    }
  }
  if (!projectId) {
    updateEditorContext();
    return;
  }

  const root = state.getProjectRoot() || (await ensureProjectRoot(projectId));
  if (!root) {
    updateEditorContext();
    return;
  }

  if (!state.getEntries().length) {
    try {
      const q = await (await api()).queue(projectId, { mutate: false });
      state.setEntries(q.entries || []);
    } catch {
      updateEditorContext();
      return;
    }
  }

  const hit = findEntryForEditorPath(fsPath, state.getEntries(), root);
  if (!hit) {
    debug.log(`active→queue miss (${reason}): ${fsPath}`);
    updateEditorContext();
    return;
  }

  // Queue click already selected the new row; while the previous editor tab is
  // still active for a beat, do not reveal the old entry (dual highlight).
  if (Date.now() < suppressEditorRevealUntil) {
    if (queueClickEntryId && String(hit.id) !== queueClickEntryId) {
      debug.log(
        `active→queue skip reveal (${reason}): editor still ${hit.id}, queue click wants ${queueClickEntryId}`,
      );
      updateEditorContext();
      return;
    }
  }

  const prev = state.getLastEntry();
  const changed = !prev || String(prev.id) !== String(hit.id);
  if (changed) {
    debug.log(`active→queue hit (${reason}): ${hit.id} ${hit.path}`);
    state.setLastEntry(hit);
    deskPanel?.refresh();
  }
  // From file browser: apply single-row selection. From queue click: host already did.
  if (!(Date.now() < suppressEditorRevealUntil && queueClickEntryId === String(hit.id))) {
    const ok = await queueView?.revealEntry(hit);
    if (ok === false) {
      debug.log(`reveal failed for ${hit.id} (${reason})`);
    }
  }
  updateEditorContext();
}

/**
 * Unified diagnostics — identity, connection, project/queue, selection sync.
 * Command: Kettle: Debug  (aliases: showDebugLog, debugSelectionSync)
 *
 * Also written to ~/.cache/kettle/plugin-debug.log for agent/CLI access.
 */
async function runKettleDebug(): Promise<void> {
  debug.showDebugChannel();
  debug.log("======== KETTLE DEBUG ========");
  debug.logIdentitySnapshot();

  debug.log("—— connection ——");
  debug.log(`connected     ${state.getState().connected}`);
  debug.log(`statusText    ${state.getState().statusText}`);
  debug.log(`cached base   ${cached?.baseUrl ?? "(none)"}`);
  try {
    const a = await api();
    const p = await a.ping();
    debug.log(`ping         ok pid=${p.pid} port=${p.port}`);
  } catch (e) {
    debug.log(`ping         FAIL ${e instanceof Error ? e.message : String(e)}`);
  }

  debug.log("—— project / queue ——");
  let projectId = state.getProjectId();
  if (!projectId) {
    try {
      projectId = await resolveProjectId();
    } catch {
      projectId = undefined;
    }
  }
  if (projectId && !state.getEntries().length) {
    try {
      const q = await (await api()).queue(projectId, { mutate: false });
      state.setEntries(q.entries || []);
    } catch (e) {
      debug.log(`queue load   FAIL ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const root =
    state.getProjectRoot() ||
    (projectId ? await ensureProjectRoot(projectId) : undefined);
  debug.log(`projectId     ${projectId ?? "(none)"}`);
  debug.log(`projectRoot   ${root ?? "(none)"}`);
  debug.log(`founding      ${state.getFoundingPhase()}`);
  debug.log(`entries       ${state.getEntries().length}`);
  debug.log(
    `lastEntry     ${
      state.getLastEntry()
        ? `${state.getLastEntry()!.id} ${state.getLastEntry()!.path}`
        : "(none)"
    }`,
  );

  const ed = vscode.window.activeTextEditor;
  const editorPath =
    ed?.document.uri.scheme === "file" ? ed.document.uri.fsPath : null;
  debug.log("—— selection sync ——");
  const probe = buildSelectionProbe({
    reason: "kettle.debug",
    editorFsPath: editorPath,
    projectId,
    projectRoot: root,
    entries: state.getEntries(),
  });
  debug.logBlock(formatSelectionProbe(probe));

  const cache = queueView?.getCacheSnapshot();
  debug.log(
    `tree cache: size=${cache?.size ?? 0} ids=${cache?.ids.join(",") || "(empty)"}`,
  );

  if (probe.matchId) {
    const entry = state.getEntries().find((e) => String(e.id) === probe.matchId);
    if (entry && queueView) {
      state.setLastEntry(entry);
      deskPanel?.refresh();
      const reveal = await queueView.diagnoseReveal(entry);
      debug.logBlock(formatRevealProbe(reveal));
    }
  } else {
    debug.log("No path match — reveal skipped.");
  }

  debug.log(`log file      ${debug.logFilePath()}`);
  debug.log("======== END KETTLE DEBUG ========");
  void vscode.window.showInformationMessage(
    `Kettle debug written to Output channel and ${debug.logFilePath()}`,
  );
}

function onDidChangeActiveEditor(_ed: vscode.TextEditor | undefined): void {
  void syncActiveFileToKettle("activeEditor");
}

function isCursorHost(): boolean {
  return /cursor/i.test(vscode.env.appName || "");
}

/**
 * Desk lives in the Secondary Side Bar so it sits opposite Explorer:
 * - VS Code (primary left): Desk on the right
 * - Cursor (primary often right): Desk on the left, beside Agent
 */
async function revealDeskSurface(): Promise<void> {
  // Prefer focus commands (never toggle — toggle closes an already-open bar).
  for (const cmd of [
    "workbench.view.extension.kettle-desk",
    "workbench.action.focusAuxiliaryBar",
    "kettle.deskPanel.focus",
  ]) {
    try {
      await vscode.commands.executeCommand(cmd);
    } catch {
      /* host may not expose every command */
    }
  }
}

async function maybeShowLayoutTip(context: vscode.ExtensionContext): Promise<void> {
  if (!isCursorHost()) return;
  const key = "kettle.cursorLayoutTipShown";
  if (context.globalState.get(key)) return;
  await context.globalState.update(key, true);
  const pick = await vscode.window.showInformationMessage(
    "Kettle Desk sits in the Secondary Side Bar (opposite Explorer). " +
      "In Cursor that is usually the left column — queue stays with Explorer on the right, " +
      "so you can review without toggling. Use View → Appearance → Secondary Side Bar if it is hidden.",
    "Show Desk",
    "Got it",
  );
  if (pick === "Show Desk") await revealDeskSurface();
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  workspaceReloadInFlight = false;
  const identity = debug.logActivate(context);
  debug.log(`activate: workspace package at ${identity.extensionPath}`);
  debug.log(`host layout: appName=${identity.appName} cursor=${isCursorHost()}`);

  // Stable paths for fleet + sole workspaces (trust parent ~/.kettle in host Trusted Folders).
  void ensureKettleWorkspaceLayout();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "kettle.debug";
  statusItem.text = "$(circle-outline) Kettle";
  statusItem.tooltip = `Kettle ${identity.version} · ${identity.buildId} (click: Debug)`;
  statusItem.show();
  context.subscriptions.push(statusItem);
  context.subscriptions.push(
    vscode.commands.registerCommand("kettle.debug", () => runKettleDebug()),
    // Aliases — keep old command ids working for keybindings / muscle memory
    vscode.commands.registerCommand("kettle.showDebugLog", () => runKettleDebug()),
    vscode.commands.registerCommand("kettle.debugSelectionSync", () => runKettleDebug()),
  );
  context.subscriptions.push({ dispose: () => debug.disposeDebug() });

  // Seed empty editor curator fields from core; push any explicit editor overrides.
  void (async () => {
    try {
      await pullCuratorSettingsFromCore();
      await pushCuratorSettingsToCore();
      await pushBehaviorSettingsToCore();
    } catch {
      /* core may not be up yet — Desk ready will retry via refresh */
    }
  })();

  deskPanel = new DeskPanelProvider({
    approve: (e) => approveEntry(e),
    comment: (e, text) => commentEntry(e, text),
    sweep: async (opts) => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) throw new Error("No project selected");
      if (!(await confirmSweep(projectId))) {
        const cancel = new Error("Sweep cancelled");
        cancel.name = "AbortError";
        throw cancel;
      }
      await (await api()).sweep(projectId, {
        thrust: opts?.thrust,
        onEvent: opts?.onEvent,
        signal: opts?.signal,
      });
      await refreshQueue();
      void vscode.window.showInformationMessage(`Sweep finished for ${projectId}.`);
    },
    chat: async (message, opts) => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) throw new Error("No project selected");
      const entry = state.getLastEntry();
      await (await api()).chat(projectId, message, {
        entryId: entry?.id,
        onEvent: opts?.onEvent,
        signal: opts?.signal,
      });
    },
    interview: async (message, opts) => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) throw new Error("No project selected");
      state.setFoundingPhase("interviewing");
      await (await api()).interview(projectId, message, {
        onEvent: opts?.onEvent,
        signal: opts?.signal,
      });
    },
    propose: async (opts) => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) throw new Error("No project selected");
      await (await api()).propose(projectId, {
        onEvent: opts?.onEvent,
        signal: opts?.signal,
      });
      state.setFoundingPhase("proposing");
      // Mutate refresh so a proposal-only desk gets a real queue entry when needed.
      try {
        const q = await (await api()).queue(projectId, { mutate: true });
        state.setEntries(q.entries || []);
        await refreshFoundingPhase(projectId);
        deskPanel?.refresh();
        queueView?.refresh();
      } catch {
        await refreshQueue();
      }
      await openDraftedProposal(projectId);
      // Desk webview held focus on "Confirm & draft"; re-assert after the message loop.
      setTimeout(() => {
        void openDraftedProposal(projectId);
      }, 200);
      setTimeout(() => {
        void openDraftedProposal(projectId);
      }, 1000);
      void vscode.window.showInformationMessage(
        UI_COPY.proposingQueueHintBody,
      );
    },
    openDraftedProposal: async () => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) return;
      await openDraftedProposal(projectId);
    },
    compact: async (opts) => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) throw new Error("No project selected");
      return compactProject(projectId, {
        onEvent: opts?.onEvent,
        signal: opts?.signal,
      });
    },
    openSettings: () => {
      void openSettingsMenu();
    },
    openEntry: (e) => openEntry(e),
    refreshDiff: (e) => refreshDiffForEntry(e),
    jumpToActive: () => jumpToActiveEditorEntry(),
    listProjects: () => listProjectsForDesk(),
    selectProject: async (projectId) => {
      debug.logDesk("workspace.selectProject", {
        projectId: projectId || "(picker)",
      });
      try {
        const id = projectId
          ? await bindProjectById(projectId)
          : await resolveProjectId(true);
        debug.logDesk("workspace.selectProject.bound", { id: id || "" });
        if (id) {
          // If bind already triggered a reload, afterProjectBound is still safe
          // (sole window → already; or no-ops refresh).
          await afterProjectBound(id);
        }
      } catch (e) {
        debug.log(
          `selectProject failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        void vscode.window.showErrorMessage(
          formatErr("Could not select project", e),
        );
      }
    },
    registerProject: async () => {
      await registerNewProject();
    },
    listModels: async () => {
      try {
        return await listModelsForDesk();
      } catch {
        return { models: [], activeId: "" };
      }
    },
    setChatModel: async (modelId, provider) => {
      await (await api()).setCuratorModel(modelId, {
        provider,
        task: "chat",
        effort: cfgEffort() || undefined,
      });
      await mirrorChatModelToEditorSettings(modelId, provider);
    },
    revealDeskFolder: (opts) => revealKettleDeskFolder(opts),
  });

  queueView = registerQueueView(context, {
    openEntry,
    beginFounding,
    refreshQueue,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DeskPanelProvider.viewType, deskPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("kettle.serverUrl") ||
        e.affectsConfiguration("kettle.baseUrl")
      ) {
        invalidateApi();
      }
      if (
        e.affectsConfiguration("kettle.project") ||
        e.affectsConfiguration("kettle.projectId")
      ) {
        const id = cfgProject();
        if (id) void ensureProjectRoot(id).then(() => refreshQueue());
      }
      // Editor curator settings → core (provider / chat / setup / effort).
      if (
        e.affectsConfiguration("kettle.provider") ||
        e.affectsConfiguration("kettle.chatModel") ||
        e.affectsConfiguration("kettle.setupModel") ||
        e.affectsConfiguration("kettle.effort")
      ) {
        void pushCuratorSettingsToCore();
      }
      if (e.affectsConfiguration("kettle.sweepVerbosity")) {
        void pushBehaviorSettingsToCore();
      }
      // Dampen Desk ritual buttons when the user zooms the workbench
      // (Cmd/Ctrl +/= or window.zoomLevel) so they don't balloon on small screens.
      if (e.affectsConfiguration("window.zoomLevel")) {
        deskPanel?.pushRitualZoom();
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((ed) => onDidChangeActiveEditor(ed)),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      void syncActiveFileToKettle("tabs");
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === "file") void syncActiveFileToKettle("openDoc");
    }),
    // Cursor sometimes skips editor events when picking from the file tree.
    // Light poll while focused — only acts when the active path changes.
    (() => {
      let lastPath = "";
      const tick = () => {
        const ed = vscode.window.activeTextEditor;
        const p =
          ed?.document.uri.scheme === "file" ? ed.document.uri.fsPath : "";
        if (p && p !== lastPath) {
          lastPath = p;
          void syncActiveFileToKettle("poll");
        }
      };
      const handle = setInterval(tick, 400);
      return { dispose: () => clearInterval(handle) };
    })(),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      void onDidSaveDocument(doc);
    }),

    vscode.commands.registerCommand("kettle.restartCore", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Restarting Kettle core…",
            cancellable: false,
          },
          async () => {
            invalidateApi();
            const next = await restartCore({
              preferredUrl: preferredCoreUrl(),
              command: cfgCommand(),
              previous: sidecar,
            });
            sidecar = next;
            cached = { baseUrl: next.baseUrl, api: new KettleApi(next.baseUrl) };
            await touchConnection();
            const id = state.getProjectId() || (await resolveProjectId());
            if (id) await refreshQueue();
          },
        );
        void vscode.window.showInformationMessage(
          "Kettle core restarted (server --replace on the live port).",
        );
      } catch (e) {
        invalidateApi();
        void vscode.window.showErrorMessage(formatErr("Could not restart Kettle core", e));
      }
    }),

    vscode.commands.registerCommand("kettle.ping", async () => {
      try {
        invalidateApi();
        // api() attaches or auto-starts the live core (product default).
        const client = await api();
        const ping = await client.ping();
        state.setConnected(true, `Kettle · :${ping.port}`);
        if (statusItem) {
          statusItem.text = `$(check) Kettle :${ping.port}`;
          statusItem.tooltip = `Core pid ${ping.pid} · ${cached?.baseUrl}`;
        }
        const reg = ping.projects ? ` · ${ping.projects}` : "";
        const contract =
          ping.api_version == null || ping.desk_schema_version == null
            ? " · legacy contract identity"
            : ` · core ${ping.version || "unknown"} · API ${ping.api_version} · desk ${ping.desk_schema_version}`;
        void vscode.window.showInformationMessage(
          `Kettle core ok (pid ${ping.pid}, port ${ping.port})${contract}${reg}`,
        );
      } catch (e) {
        invalidateApi();
        void vscode.window.showErrorMessage(
          formatErr(
            "Could not reach or start Kettle core — check kettle.command / ~/.kettle-venv",
            e,
          ),
        );
      }
    }),

    vscode.commands.registerCommand("kettle.selectProject", async () => {
      const id = await resolveProjectId(true);
      if (id) await afterProjectBound(id);
    }),

    vscode.commands.registerCommand("kettle.registerProject", async () => {
      await registerNewProject();
    }),

    vscode.commands.registerCommand("kettle.refreshQueue", async () => {
      await refreshQueue();
    }),

    vscode.commands.registerCommand("kettle.showQueue", async () => {
      const projectId = await resolveProjectId();
      if (!projectId) return;
      try {
        const q = await (await api()).queue(projectId, { mutate: false });
        const entries = q.entries || [];
        state.setEntries(entries);
        const lines = entries.length
          ? entries.map((e) => entryLabel(e)).join("\n")
          : "(empty)";
        const doc = await vscode.workspace.openTextDocument({
          content: `Kettle queue — ${projectId}\n\n${lines}\n`,
          language: "plaintext",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        invalidateApi();
        void vscode.window.showErrorMessage(formatErr("Could not load queue", e));
      }
    }),

    vscode.commands.registerCommand("kettle.openEntry", async () => {
      const projectId = await resolveProjectId();
      if (!projectId) return;
      const entry = await pickEntry(projectId);
      if (!entry) return;
      await openEntry(entry);
    }),

    vscode.commands.registerCommand("kettle.approve", async () => {
      const entry = await resolveEntryForAction({ pendingOnly: true });
      if (!entry) return;
      await approveEntry(entry);
    }),

    /** Queue tree: Approve on a row (context menu / inline). */
    vscode.commands.registerCommand(
      "kettle.queue.approve",
      async (item?: { entry?: QueueEntry; kind?: string }) => {
        const entry = item?.entry;
        if (!entry) {
          const fallback = await resolveEntryForAction({ pendingOnly: true });
          if (!fallback) return;
          await approveEntry(fallback);
          return;
        }
        if (isApprovedEntry(entry)) {
          void vscode.window.showInformationMessage("That entry is already approved.");
          return;
        }
        await approveEntry(entry);
      },
    ),

    vscode.commands.registerCommand("kettle.comment", async () => {
      const entry = await resolveEntryForAction();
      if (!entry) return;
      const text = await vscode.window.showInputBox({
        prompt: `Comment on ${entry.path} (empty clears)`,
        value: entry.comment || "",
        placeHolder: "Send-back note for the curator",
      });
      if (text === undefined) return;
      await commentEntry(entry, text);
    }),

    vscode.commands.registerCommand("kettle.sweep", async () => {
      const projectId = await resolveProjectId();
      if (!projectId) return;
      if (!(await confirmSweep(projectId))) return;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Kettle sweep — ${projectId}`,
            cancellable: false,
          },
          async () => {
            await (await api()).sweep(projectId);
          },
        );
        await refreshQueue();
        void vscode.window.showInformationMessage(`Sweep finished for ${projectId}.`);
      } catch (e) {
        invalidateApi();
        void vscode.window.showErrorMessage(formatErr("Sweep failed", e));
      }
    }),

    vscode.commands.registerCommand("kettle.refreshBriefs", async () => {
      const projectId = await resolveProjectId();
      if (!projectId) return;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Refreshing briefs — ${projectId}`,
            cancellable: false,
          },
          async () => {
            await (await api()).refreshBriefs(projectId);
          },
        );
        await refreshQueue();
        void vscode.window.showInformationMessage(
          `Briefs refreshed for ${projectId} (cold re-entry standard).`,
        );
      } catch (e) {
        invalidateApi();
        // Stale long-running cores (started before /api/refresh-briefs existed)
        // answer 404 "not found" — point at Restart Core rather than a dead end.
        const msg = e instanceof Error ? e.message : String(e);
        const staleCore =
          /not found/i.test(msg) ||
          (e instanceof KettleApiError && e.status === 404);
        void vscode.window.showErrorMessage(
          staleCore
            ? `Refresh briefs failed: core does not expose /api/refresh-briefs (${msg}). ` +
                "Run Kettle: Restart Core (or restart `kettle --web`) so the live process loads the current server.py, then try again."
            : formatErr("Refresh briefs failed", e),
        );
      }
    }),

    vscode.commands.registerCommand("kettle.jumpActive", async () => {
      await jumpToActiveEditorEntry();
    }),

    vscode.commands.registerCommand("kettle.showDesk", async () => {
      await revealDeskSurface();
    }),

    vscode.commands.registerCommand("kettle.beginFounding", async () => {
      await beginFounding();
    }),

    vscode.commands.registerCommand("kettle.compactSession", async () => {
      const projectId = state.getProjectId() || (await resolveProjectId());
      if (!projectId) {
        void vscode.window.showWarningMessage("Select a Kettle project first.");
        return;
      }
      await vscode.commands.executeCommand("kettle.deskPanel.focus");
      try {
        deskPanel?.noteSys("— compacting the working session —");
        let compacted = false;
        if (deskPanel) {
          await deskPanel.runHostStream("compact", async (onEvent) => {
            compacted = await compactProject(projectId, { onEvent });
          });
        } else {
          compacted = await compactProject(projectId);
        }
        const notice = compacted
          ? "context compacted — the thread continues, summarized"
          : "no active session — nothing to compact";
        if (deskPanel) deskPanel.noteSys(notice);
        else void vscode.window.showInformationMessage(notice);
      } catch (e) {
        invalidateApi();
        void vscode.window.showErrorMessage(formatErr("Compact failed", e));
      }
    }),
  );

  registerKettleTools(context, {
    getApi: api,
    getProjectId: () => resolveProjectId(),
    getProjectRoot: () => state.getProjectRoot(),
    getLastEntry: () => state.getLastEntry(),
    refreshQueue,
    onDeskAction: () => deskPanel?.refresh(),
  });
  registerKettleParticipant(context, {
    getApi: api,
    getProjectId: () => resolveProjectId(),
  });

  // Warm connection (attach or auto-start live core) + project inference in background
  void (async () => {
    // Bring Desk forward in the secondary bar (Cursor left / VS Code right) when enabled.
    // Skip when founding just asked Explorer to hold focus on `.kettle`.
    if (cfgFocusDeskOnActivate() && Date.now() >= suppressDeskAutofocusUntil) {
      debug.log("focusDeskOnActivate: revealing Kettle Desk");
      await revealDeskSurface();
    }
    await maybeShowLayoutTip(context);
    const ok = await touchConnection();
    if (!ok) {
      void vscode.window.showWarningMessage(
        "Kettle could not start core. Set kettle.command to ~/.kettle-venv/bin/kettle, or run kettle --web once.",
      );
      return;
    }
    // After openFolder: re-bind the project we were switching to, then maybe found.
    // Pending keys are global (shared by all windows) — only apply when the
    // pending project's root matches this window's folders. Otherwise a relaunch
    // of armada.code-workspace can wrongly bind a stale content_engine handoff.
    const pendingBind = context.globalState.get<string>(PENDING_BIND_KEY);
    const pendingFounding = context.globalState.get<string>(PENDING_FOUNDING_KEY);
    const pendingExpandQueue = context.globalState.get<boolean>(PENDING_EXPAND_QUEUE_KEY);
    let resumedWorkspaceSwitch = false;
    const openFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (pendingBind || pendingFounding) {
      const resumeId = (pendingFounding || pendingBind || "").trim();
      let appliedPending = false;
      try {
        const { projects } = await (await api()).projects();
        const p = resumeId ? projects.find((x) => x.id === resumeId) : undefined;
        const pendingMatchesOpen =
          !!p?.root &&
          (!openFolders.length || workspaceMatchesProject(openFolders, p.root));
        debug.logDesk("workspace.resumeAfterOpenFolder", {
          projectId: resumeId,
          founding: !!pendingFounding,
          expandQueue: !!pendingExpandQueue,
          pendingMatchesOpen,
          workspaceFile: vscode.workspace.workspaceFile?.fsPath || "",
          folders: openFolders,
        });
        if (p && pendingMatchesOpen) {
          // Consume handoff only when it matches this window.
          await context.globalState.update(PENDING_BIND_KEY, undefined);
          await context.globalState.update(PENDING_FOUNDING_KEY, undefined);
          await clearPendingSwitchMode();
          resumedWorkspaceSwitch = true;
          appliedPending = true;
          await bindProject(p, { skipMismatchConfirm: true });
          await refreshQueue();
          await refreshFoundingPhase(resumeId);
          deskPanel?.refresh();
          queueView?.refresh();
          if (
            pendingFounding &&
            (state.getFoundingPhase() === "none" ||
              state.getFoundingPhase() === "interviewing")
          ) {
            await beginFounding();
          }
        } else if (resumeId) {
          // Stale handoff for another window — leave keys if another window
          // might still need them only when folders empty (unknown). If we have
          // folders and they don't match, drop the handoff so we don't poison
          // every future relaunch of the wrong desk.
          if (openFolders.length) {
            debug.log(
              `workspace.resume: drop stale pending “${resumeId}” ` +
                `(open folders do not match its root ${p?.root || "?"})`,
            );
            await context.globalState.update(PENDING_BIND_KEY, undefined);
            await context.globalState.update(PENDING_FOUNDING_KEY, undefined);
            await clearPendingSwitchMode();
          } else {
            debug.log(
              `workspace.resume: defer pending “${resumeId}” — no folders yet`,
            );
          }
        }
      } catch (e) {
        invalidateApi();
        debug.log(
          `workspace.resume failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      void appliedPending;
    }
    // One-shot: expand Explorer → Kettle after a Kettle project-window load
    // only when this window applied a matching handoff (or folders match expand intent).
    if (pendingExpandQueue && resumedWorkspaceSwitch) {
      await context.globalState.update(PENDING_EXPAND_QUEUE_KEY, undefined);
      // Yield so Explorer finishes rebuilding after openFolder.
      await new Promise((r) => setTimeout(r, 350));
      await expandKettleExplorerQueue();
    } else if (pendingExpandQueue && openFolders.length) {
      // Stale expand flag from another window's handoff — clear so it does not
      // keep re-firing on unrelated launches.
      await context.globalState.update(PENDING_EXPAND_QUEUE_KEY, undefined);
    }

    // Always prefer a desk whose root matches the open folder(s). If a stale
    // resume bound the wrong project, re-resolve from the workspace path.
    let id = state.getProjectId();
    if (openFolders.length) {
      const matched = await (async () => {
        try {
          const { projects } = await (await api()).projects();
          return matchProjectId(projects, "", openFolders);
        } catch {
          return undefined;
        }
      })();
      if (matched && matched !== id) {
        debug.log(
          `project rebind to workspace match “${matched}” (was “${id || ""}”)`,
        );
        try {
          const { projects } = await (await api()).projects();
          const p = projects.find((x) => x.id === matched);
          if (p) {
            await bindProject(p, { skipMismatchConfirm: true });
            id = matched;
            resumedWorkspaceSwitch = false; // allow normal queue refresh below
          }
        } catch {
          /* keep prior id */
        }
      } else if (!id) {
        id = (await resolveProjectId()) || undefined;
      }
    } else if (!id) {
      id = (await resolveProjectId()) || undefined;
    }

    if (id) await refreshQueue();

    // Cursor agent → Open IDE: workspace folders can appear a beat after activate.
    // Retry bind when folders change or after a short delay if still unbound.
    // Also rebind if folders appear and disagree with the current desk.
    {
      const tryBindFromWorkspace = async (reason: string): Promise<void> => {
        const folders = (vscode.workspace.workspaceFolders || []).map(
          (f) => f.uri.fsPath,
        );
        if (!folders.length) return;
        try {
          const { projects } = await (await api()).projects();
          const matched = matchProjectId(projects, "", folders);
          if (!matched) return;
          if (state.getProjectId() === matched) return;
          const p = projects.find((x) => x.id === matched);
          if (!p) return;
          debug.log(`project auto-bind (${reason}) → ${matched}`);
          await bindProject(p, { skipMismatchConfirm: true });
          await refreshQueue();
          deskPanel?.refresh();
          queueView?.refresh();
          onDidChangeActiveEditor(vscode.window.activeTextEditor);
        } catch {
          /* core may be down */
        }
      };
      context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
          void tryBindFromWorkspace("folders-changed");
        }),
      );
      setTimeout(() => {
        void tryBindFromWorkspace("activate-retry");
      }, 750);
    }

    // Match active editor if any
    onDidChangeActiveEditor(vscode.window.activeTextEditor);

    // Unfounded desk: offer founding in the Desk panel (not Desktop).
    // Skip prompt when we already resumed a workspace switch above.
    if (!resumedWorkspaceSwitch && id && state.getFoundingPhase() === "none") {
      const pick = await vscode.window.showInformationMessage(
        `Kettle project “${id}” is not founded yet. Begin the interview in the Desk panel?`,
        "Begin interview",
        "Later",
      );
      if (pick === "Begin interview") await beginFounding();
    } else if (
      !resumedWorkspaceSwitch &&
      id &&
      state.getFoundingPhase() === "interviewing"
    ) {
      const pick = await vscode.window.showInformationMessage(
        `Founding interview in progress for “${id}”. Resume in the Desk panel?`,
        "Show Desk",
        "Later",
      );
      if (pick === "Show Desk") {
        await vscode.commands.executeCommand("kettle.deskPanel.focus");
      }
    }
  })();
}

export function deactivate(): void {
  cached = null;
  disposeSidecar(sidecar);
  sidecar = undefined;
}
