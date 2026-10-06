/**
 * Explorer → Kettle TreeView — list + navigate + approve chrome.
 *
 * Layout per row:  [file icon]  path…  meta  [check on the right]
 *
 * - **File icon** — always product icon theme (`ThemeIcon.File` + resourceUri).
 * - **Approved** — gray/struck path (FileDecoration); persistent text `✓` in
 *   description (always visible, not hover-only).
 * - **Active pending only** — inline `$(check)` Approve button (right). No
 *   check on inactive pending rows (including on hover).
 * - Description shows +/− diff only (no urgency tags). TreeItem description is
 *   single-color in the host API — +/- cannot be green/red here.
 * - **Selection** — `revealEntry` after list rebuild so editor/file-browser
 *   sync keeps a single highlighted row (`getParent` required).
 */
import * as vscode from "vscode";
import type { QueueEntry } from "./api";
import {
  entryAbsolutePath,
  entryDisplayPath,
  isApprovedEntry,
  isHandledEntry,
  isSetAsideEntry,
  sortQueueForDisplay,
} from "./project";
import type { RevealProbe } from "./selectionSync";
import * as state from "./state";
import { uiCopy } from "./uiCopy";

/**
 * Custom scheme so Git (and other file:// decorators) do not paint queue rows.
 * Modified files otherwise stay amber and override our gray approved color.
 * Path is still the absolute fs path so ThemeIcon.File can pick icons by extension.
 */
const QUEUE_URI_SCHEME = "kettle-q";

function queueResourceUri(absPath: string): vscode.Uri {
  // Ensure path is absolute-form for Uri (leading / on POSIX).
  const p = absPath.startsWith("/") ? absPath : `/${absPath}`;
  return vscode.Uri.from({ scheme: QUEUE_URI_SCHEME, path: p });
}

export type QueueViewDeps = {
  openEntry: (
    entry: QueueEntry,
    opts?: { fromQueueClick?: boolean },
  ) => Promise<void>;
  beginFounding: () => Promise<void>;
  refreshQueue: () => Promise<void>;
};

type ItemKind = "entry" | "hint" | "founding";

class QueueItem extends vscode.TreeItem {
  constructor(
    public readonly kind: ItemKind,
    label: string,
    public readonly entry?: QueueEntry,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

/**
 * Signature of queue *data* that requires a full tree rebuild.
 * Deliberately omits lastEntry/selection — that only moves the active Approve
 * chrome and must not re-fire FileDecoration (approved rows flash otherwise).
 */
function dataListSignature(): string {
  const s = state.getState();
  const entries = s.entries
    .map(
      (e) =>
        `${e.id}:${e.status || ""}:${e.approved || ""}:${e.diff?.added || 0}:${e.diff?.removed || 0}`,
    )
    .join("|");
  return `${s.projectId || ""}@@${s.foundingPhase}@@${entries}`;
}

export class QueueTreeProvider implements vscode.TreeDataProvider<QueueItem> {
  public static readonly viewType = "kettle.queue";

  private readonly _onDidChange = new vscode.EventEmitter<
    QueueItem | QueueItem[] | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private unsub: (() => void) | undefined;
  private treeView: vscode.TreeView<QueueItem> | undefined;
  /** Elements last returned to the TreeView — required for reveal(). */
  private elementsById = new Map<string, QueueItem>();
  private lastDataSig = "";
  private lastActiveId: string | undefined;
  private approvedUris = new Set<string>();
  /** Set-aside rows (Not this): dimmed, not struck — they can be brought back. */
  private setAsideUris = new Set<string>();
  private readonly _onDidChangeDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  /** Monotonic id so only the latest reveal wins (avoids dual highlights). */
  private revealGen = 0;

  constructor(private readonly deps: QueueViewDeps) {
    this.unsub = state.subscribe(() => {
      const dataSig = dataListSignature();
      const activeId = state.getLastEntry()
        ? String(state.getLastEntry()!.id)
        : undefined;
      if (dataSig !== this.lastDataSig) {
        this.lastDataSig = dataSig;
        this.lastActiveId = activeId;
        this.refresh();
        return;
      }
      // Selection-only: move active Approve chrome without rebuilding the list
      // (and without re-painting approved FileDecorations).
      if (activeId !== this.lastActiveId) {
        const prev = this.lastActiveId;
        this.lastActiveId = activeId;
        this.patchActiveChrome(prev, activeId);
      }
    });
  }

  dispose(): void {
    this.unsub?.();
    this._onDidChange.dispose();
    this._onDidChangeDecorations.dispose();
  }

  attachTreeView(view: vscode.TreeView<QueueItem>): void {
    this.treeView = view;
  }

  refresh(): void {
    // Tree rebuild only; getChildren fires decorations if the approved set changed.
    this._onDidChange.fire(undefined);
  }

  /**
   * Update only the pending rows that gained/lost the active Approve check.
   * Keeps TreeItem object identity so the host does not re-materialize the list.
   */
  private patchActiveChrome(
    prevId: string | undefined,
    nextId: string | undefined,
  ): void {
    const touched: QueueItem[] = [];
    for (const id of [prevId, nextId]) {
      if (!id) continue;
      const item = this.elementsById.get(id);
      if (!item?.entry || isHandledEntry(item.entry)) continue;
      const isActive = id === nextId;
      item.contextValue = isActive
        ? "kettle.entry.active"
        : "kettle.entry";
      // Tooltip mentions active state — refresh without full rebuild.
      const root = state.getProjectRoot() || "";
      const rebuilt = entryItem(item.entry, root);
      item.tooltip = rebuilt.tooltip;
      item.description = rebuilt.description;
      touched.push(item);
    }
    if (touched.length === 1) this._onDidChange.fire(touched[0]);
    else if (touched.length > 1) this._onDidChange.fire(touched);
  }

  getTreeItem(element: QueueItem): vscode.TreeItem {
    return element;
  }

  /**
   * Required for TreeView.reveal(). Flat list: every row is a root, so no parent.
   * Without this, Cursor/VS Code throws:
   * "Required registered TreeDataProvider to implement 'getParent' method to access 'reveal'"
   */
  getParent(_element: QueueItem): vscode.ProviderResult<QueueItem> {
    return undefined;
  }

  getChildren(): QueueItem[] {
    this.elementsById.clear();
    const projectId = state.getProjectId();
    if (!projectId) {
      return [
        hintItem(
          "Select a Kettle project",
          "Run Kettle: Select Project or Kettle: Add Project",
        ),
      ];
    }

    const entries = state.getEntries();
    const root = state.getProjectRoot() || "";
    if (!entries.length) {
      const phase = state.getFoundingPhase();
      if (phase !== "founded") {
        return [foundingItem(phase)];
      }
      return [hintItem("Queue empty", projectId)];
    }

    const ordered = sortQueueForDisplay(entries);
    const items = ordered.map((e) => entryItem(e, root));
    // Decoration key off the same Uri strings as item.resourceUri.
    const nextApproved = new Set(
      items
        .filter((i) => i.entry && isApprovedEntry(i.entry) && i.resourceUri)
        .map((i) => i.resourceUri!.toString()),
    );
    const nextSetAside = new Set(
      items
        .filter((i) => i.entry && isSetAsideEntry(i.entry) && i.resourceUri)
        .map((i) => i.resourceUri!.toString()),
    );
    const approvedChanged =
      nextApproved.size !== this.approvedUris.size ||
      [...nextApproved].some((u) => !this.approvedUris.has(u)) ||
      nextSetAside.size !== this.setAsideUris.size ||
      [...nextSetAside].some((u) => !this.setAsideUris.has(u));
    this.approvedUris = nextApproved;
    this.setAsideUris = nextSetAside;
    this.elementsById.clear();
    for (const item of items) {
      if (item.entry) this.elementsById.set(String(item.entry.id), item);
    }
    this.lastDataSig = dataListSignature();
    this.lastActiveId = state.getLastEntry()
      ? String(state.getLastEntry()!.id)
      : undefined;
    // Only repaint decorations when the approved set actually changed.
    if (approvedChanged) {
      this._onDidChangeDecorations.fire(undefined);
    }
    // After a real list rebuild, re-apply single selection highlight.
    const active = state.getLastEntry();
    if (active) {
      const gen = ++this.revealGen;
      queueMicrotask(() => {
        if (gen !== this.revealGen) return;
        void this.revealEntry(active);
      });
    }
    return items;
  }

  async onSelect(item: QueueItem): Promise<void> {
    if (item.kind === "founding") {
      await this.deps.beginFounding();
      return;
    }
    if (item.kind === "entry" && item.entry) {
      // Host already applied selection on this click — open file without reverse-sync fight.
      await this.deps.openEntry(item.entry, { fromQueueClick: true });
    }
  }

  /** Snapshot of the element cache (for diagnostics). */
  getCacheSnapshot(): { size: number; ids: string[] } {
    return {
      size: this.elementsById.size,
      ids: [...this.elementsById.keys()],
    };
  }

  /**
   * Apply the normal TreeView **selection highlight** to this entry
   * (same as a click). Uses a generation counter so only the latest request
   * sticks — avoids two rows looking selected when sync races.
   */
  async revealEntry(entry: QueueEntry): Promise<boolean> {
    const gen = ++this.revealGen;
    const entryId = String(entry.id);
    const item = this.elementsById.get(entryId);
    if (!item || !this.treeView) return false;
    if (gen !== this.revealGen) return false;
    try {
      // select:true replaces selection when canSelectMany is false.
      // focus:false keeps the editor focused (file-browser → queue sync).
      await this.treeView.reveal(item, {
        select: true,
        focus: false,
        expand: true,
      });
    } catch {
      return false;
    }
    return gen === this.revealGen;
  }

  /**
   * Attempt reveal and return a structured probe (Debug command).
   */
  async diagnoseReveal(entry: QueueEntry): Promise<RevealProbe> {
    const entryId = String(entry.id);
    const notes: string[] = [];
    const item = this.elementsById.get(entryId);
    const cacheHit = !!item;
    const treeViewPresent = !!this.treeView;
    let visible: boolean | null = null;
    try {
      visible = this.treeView?.visible ?? null;
    } catch {
      visible = null;
    }

    const selectionIds = (): string[] => {
      try {
        return (this.treeView?.selection || [])
          .map((el) => (el.entry ? String(el.entry.id) : el.label?.toString() || "?"))
          .filter(Boolean);
      } catch {
        return [];
      }
    };

    const selectionBefore = selectionIds();
    let revealThrew: string | null = null;
    let revealOk = false;

    if (!cacheHit) {
      notes.push(
        "Cache miss — getChildren has not run (or list rebuilt). Expand KETTLE in Explorer so the tree materializes.",
      );
    }
    if (!treeViewPresent) {
      notes.push("No TreeView instance attached.");
    }
    if (visible === false) {
      notes.push(
        "TreeView reports visible=false — selection may apply but not be on-screen until KETTLE is expanded.",
      );
    }

    if (item && this.treeView) {
      try {
        await this.treeView.reveal(item, {
          select: true,
          focus: false,
          expand: true,
        });
        revealOk = true;
      } catch (e) {
        revealThrew = e instanceof Error ? e.message : String(e);
        notes.push(`reveal() threw: ${revealThrew}`);
      }
    }

    await new Promise((r) => setTimeout(r, 30));
    let selectionAfter = selectionIds();
    if (revealOk && !selectionAfter.includes(entryId)) {
      notes.push(
        "reveal() returned without throw, but treeView.selection does not include this id.",
      );
    }
    if (selectionAfter.length > 1) {
      notes.push(
        `Multiple rows selected (${selectionAfter.join(", ")}) — expected single selection.`,
      );
    }
    if (revealOk && selectionAfter.includes(entryId) && selectionAfter.length === 1) {
      notes.push("Single selection matches entry — host accepted selection.");
    }

    return {
      at: new Date().toISOString(),
      entryId,
      cacheHit,
      cacheSize: this.elementsById.size,
      cacheIds: [...this.elementsById.keys()],
      treeViewPresent,
      visible,
      selectionBefore,
      selectionAfter,
      revealThrew,
      revealOk,
      notes,
    };
  }

  asDecorationProvider(): vscode.FileDecorationProvider {
    const self = this;
    return {
      onDidChangeFileDecorations: self._onDidChangeDecorations.event,
      provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        // Only our queue scheme — never file:// (Git owns those colors).
        if (uri.scheme !== QUEUE_URI_SCHEME) return undefined;
        const key = uri.toString();
        const inSet = (set: Set<string>): boolean =>
          set.has(key) ||
          [...set].some((u) => {
            try {
              return vscode.Uri.parse(u).path === uri.path;
            } catch {
              return false;
            }
          });
        if (inSet(self.setAsideUris)) {
          // Dimmed, not struck: a set-aside file can be brought back.
          return new vscode.FileDecoration(
            undefined,
            "Set aside",
            new vscode.ThemeColor("disabledForeground"),
          );
        }
        if (!inSet(self.approvedUris)) return undefined;
        // Gray + strike. Path is kettle-q so Git amber cannot win.
        const dec = new vscode.FileDecoration(
          undefined,
          "Approved",
          new vscode.ThemeColor("disabledForeground"),
        );
        (dec as vscode.FileDecoration & { strikethrough?: boolean }).strikethrough = true;
        return dec;
      },
    };
  }
}

function hintItem(label: string, description?: string): QueueItem {
  const item = new QueueItem("hint", label);
  item.description = description;
  item.contextValue = "kettle.hint";
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

function foundingItem(phase: string): QueueItem {
  const item = new QueueItem(
    "founding",
    phase === "interviewing" || phase === "proposing"
      ? "Setting up — continue in the Kettle panel"
      : "Not set up yet — click to start",
  );
  item.description = "Kettle panel";
  item.contextValue = "kettle.founding";
  item.iconPath = new vscode.ThemeIcon("rocket");
  item.command = {
    command: "kettle.queue.select",
    title: "Set up project",
    arguments: [item],
  };
  return item;
}

function entryItem(entry: QueueEntry, projectRoot: string): QueueItem {
  const rel = entryDisplayPath(entry.path, projectRoot);
  const abs = entryAbsolutePath(entry.path, projectRoot);
  const approved = isApprovedEntry(entry);
  const setAside = !approved && isSetAsideEntry(entry);
  const isActive =
    state.getLastEntry() != null &&
    String(state.getLastEntry()!.id) === String(entry.id);
  const item = new QueueItem("entry", rel, entry);
  item.id = `kettle.entry.${entry.id}`;

  // Theme file icon from path extension. Use kettle-q:// so Git’s modified
  // (amber) decoration does not override approved gray styling.
  try {
    item.resourceUri = queueResourceUri(abs);
    item.iconPath = vscode.ThemeIcon.File;
  } catch {
    item.iconPath = new vscode.ThemeIcon("file");
  }

  // Diff chips only (no high/medium/low). Description is one host color —
  // cannot paint + green / − red without a custom webview list.
  const diffParts: string[] = [];
  if (entry.diff?.added) diffParts.push(`+${entry.diff.added}`);
  if (entry.diff?.removed) diffParts.push(`−${entry.diff.removed}`);
  const diffText = diffParts.join(" ");
  // Approved: plain text check (not emoji), always visible on the right of the path.
  // Active pending: Approve is the right-side inline check button only.
  if (approved) {
    item.description = ["✓", diffText].filter(Boolean).join("  ");
  } else if (setAside) {
    item.description = ["set aside", diffText].filter(Boolean).join("  ");
  } else {
    item.description = diffText || undefined;
  }

  item.tooltip = new vscode.MarkdownString(
    [
      `**${rel}**`,
      approved ? `_Approved — nothing changes until you press ${uiCopy("sweepLabel")}_` : "",
      setAside ? `_Set aside — ${uiCopy("notThisUndoLabel")} from the menu to put it back_` : "",
      isActive && !approved && !setAside ? "_Open — use ✓ to approve_" : "",
      entry.urgency ? `Urgency: ${entry.urgency}` : "",
      entry.diff && (entry.diff.added || entry.diff.removed)
        ? `Diff: +${entry.diff.added || 0} −${entry.diff.removed || 0}`
        : "",
      entry.ask || entry.brief?.slice(0, 200) || "",
      entry.comment ? `Comment: ${entry.comment}` : "",
      abs !== rel ? `\`${abs}\`` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  // Only `kettle.entry.active` gets the inline Approve check (package.json).
  item.contextValue = approved
    ? "kettle.entry.approved"
    : setAside
      ? "kettle.entry.setAside"
      : isActive
      ? "kettle.entry.active"
      : "kettle.entry";
  item.command = {
    command: "kettle.queue.select",
    title: "Open file",
    arguments: [item],
  };
  return item;
}

export function registerQueueView(
  context: vscode.ExtensionContext,
  deps: QueueViewDeps,
): QueueTreeProvider {
  const provider = new QueueTreeProvider(deps);
  const treeView = vscode.window.createTreeView(QueueTreeProvider.viewType, {
    treeDataProvider: provider,
    showCollapseAll: false,
    canSelectMany: false,
  });
  provider.attachTreeView(treeView);

  context.subscriptions.push(
    provider,
    treeView,
    vscode.window.registerFileDecorationProvider(provider.asDecorationProvider()),
    vscode.commands.registerCommand("kettle.queue.select", async (item?: QueueItem) => {
      if (item) await provider.onSelect(item);
    }),
  );
  return provider;
}
