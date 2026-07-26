/**
 * VS Code Language Model tools for Kettle desk awareness.
 * Approve bookmarks a ruling only; sweep is the commit pass.
 */
import * as vscode from "vscode";
import type { QueueEntry, KettleApi } from "../api";
import { findEntryForEditorPath } from "../paths";
import * as state from "../state";

export type ToolsDeps = {
  getApi: () => Promise<KettleApi>;
  getProjectId: () => Promise<string | undefined>;
  getProjectRoot: () => string | undefined;
  getLastEntry: () => QueueEntry | undefined;
  refreshQueue: () => Promise<void>;
  onDeskAction?: () => void;
};

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function entrySummary(e: QueueEntry): string {
  const urg = e.urgency ? `[${e.urgency}] ` : "";
  const st = e.status || "pending";
  const ask = e.ask ? ` — ${e.ask}` : "";
  const brief = e.brief ? `\n  brief: ${e.brief.slice(0, 240)}${e.brief.length > 240 ? "…" : ""}` : "";
  const comment = e.comment ? `\n  comment: ${e.comment}` : "";
  const diff =
    e.diff && (e.diff.added || e.diff.removed)
      ? `\n  diff: +${e.diff.added} −${e.diff.removed}`
      : "";
  return `${urg}${e.path} (${st}, id=${e.id})${ask}${brief}${comment}${diff}`;
}

export function registerKettleTools(
  context: vscode.ExtensionContext,
  deps: ToolsDeps,
): void {
  const reg = <T>(name: string, tool: vscode.LanguageModelTool<T>) => {
    context.subscriptions.push(vscode.lm.registerTool(name, tool));
  };

  reg("kettle_status", {
    async invoke() {
      try {
        const api = await deps.getApi();
        const ping = await api.ping();
        const projectId = await deps.getProjectId();
        const last = deps.getLastEntry();
        const curator = ping.curator
          ? {
              ...ping.curator,
              models: Object.fromEntries(
                Object.entries(ping.curator.models || {}).filter(([k]) => k !== "glance"),
              ),
            }
          : null;
        return textResult(
          JSON.stringify(
            {
              ok: true,
              app: ping.app,
              pid: ping.pid,
              port: ping.port,
              projectId: projectId ?? null,
              lastEntry: last
                ? { id: last.id, path: last.path, status: last.status }
                : null,
              curator,
            },
            null,
            2,
          ),
        );
      } catch (e) {
        return textResult(`Kettle status error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  reg("kettle_queue", {
    async invoke() {
      try {
        const projectId = await deps.getProjectId();
        if (!projectId) {
          return textResult("No Kettle project selected. Run Kettle: Select Project.");
        }
        const api = await deps.getApi();
        const q = await api.queue(projectId, { mutate: false });
        const entries = q.entries || [];
        state.setEntries(entries);
        if (!entries.length) return textResult("Queue is empty for this project.");
        const lines = entries.map((e) => `- ${entrySummary(e)}`);
        return textResult(
          `Queue for ${projectId} (${entries.length}):\n${lines.join("\n")}\n\n` +
            `curated: ${q.curated || "(none)"}`,
        );
      } catch (e) {
        return textResult(`kettle_queue error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  reg<{ id?: string }>("kettle_entry", {
    async invoke(options) {
      try {
        const projectId = await deps.getProjectId();
        if (!projectId) return textResult("No project selected.");
        const api = await deps.getApi();
        let entries = state.getEntries();
        if (!entries.length) {
          const q = await api.queue(projectId, { mutate: false });
          entries = q.entries || [];
          state.setEntries(entries);
        }
        const id = options.input?.id?.trim();
        let entry: QueueEntry | undefined;
        if (id) {
          entry = entries.find((e) => String(e.id) === id);
        } else {
          const ed = vscode.window.activeTextEditor;
          if (ed?.document.uri.scheme === "file") {
            entry = findEntryForEditorPath(
              ed.document.uri.fsPath,
              entries,
              deps.getProjectRoot() || state.getProjectRoot(),
            );
          }
          if (!entry) entry = deps.getLastEntry();
        }
        if (!entry) {
          return textResult(
            "No matching entry. Pass id, open a queue file, or select an entry first.",
          );
        }
        state.setLastEntry(entry);
        deps.onDeskAction?.();
        return textResult(entrySummary(entry));
      } catch (e) {
        return textResult(`kettle_entry error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  reg<{ id: string; text: string }>("kettle_comment", {
    async invoke(options) {
      try {
        const projectId = await deps.getProjectId();
        if (!projectId) return textResult("No project selected.");
        const id = options.input?.id;
        const text = options.input?.text ?? "";
        if (!id) return textResult("kettle_comment requires id and text.");
        const api = await deps.getApi();
        await api.comment(projectId, id, text);
        await deps.refreshQueue();
        deps.onDeskAction?.();
        return textResult(
          text.trim()
            ? `Comment saved on entry ${id}.`
            : `Comment cleared on entry ${id}.`,
        );
      } catch (e) {
        return textResult(`kettle_comment error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async prepareInvocation(options) {
      return {
        invocationMessage: `Comment on Kettle entry ${options.input?.id ?? "?"}…`,
      };
    },
  });

  reg<{ id: string }>("kettle_approve", {
    async invoke(options) {
      try {
        const projectId = await deps.getProjectId();
        if (!projectId) return textResult("No project selected.");
        const id = options.input?.id;
        if (!id) return textResult("kettle_approve requires id.");
        // Match main UI: soft info modal; honor kettle.confirmApprove.
        const cfg = vscode.workspace.getConfiguration("kettle");
        if (cfg.get<boolean>("confirmApprove", true)) {
          const choice = await vscode.window.showInformationMessage(
            `Approve this version of ${id}?`,
            {
              modal: true,
              detail:
                'This will mark the file as approved in the Kettle queue. You must click the "sweep" button for the agent to commit and process this batch of files.',
            },
            "Approve",
            "Don't ask again",
          );
          if (choice === "Don't ask again") {
            await cfg.update("confirmApprove", false, vscode.ConfigurationTarget.Global);
          } else if (choice !== "Approve") {
            return textResult("Approve cancelled.");
          }
        }
        const api = await deps.getApi();
        await api.approve(projectId, id);
        await deps.refreshQueue();
        deps.onDeskAction?.();
        return textResult(
          `Approved entry ${id} (ruling bookmarked; run Sweep when the sitting is done).`,
        );
      } catch (e) {
        return textResult(`kettle_approve error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async prepareInvocation(options) {
      return {
        invocationMessage: `Approve Kettle entry ${options.input?.id ?? "?"} (bookmark only)…`,
        confirmationMessages: {
          title: "Approve Kettle entry?",
          message: new vscode.MarkdownString(
            "Bookmarks a user ruling only — **does not** apply diffs or commit. Sweep is the commit pass.",
          ),
        },
      };
    },
  });

  reg("kettle_sweep", {
    async invoke() {
      try {
        const projectId = await deps.getProjectId();
        if (!projectId) return textResult("No project selected.");
        const ok = await vscode.window.showWarningMessage(
          `Sweep project “${projectId}”? This is the commit pass (diff → assess → ripple → learn), not approve.`,
          { modal: true },
          "Sweep",
        );
        if (ok !== "Sweep") return textResult("Sweep cancelled.");
        const api = await deps.getApi();
        const result = await api.sweep(projectId);
        await deps.refreshQueue();
        deps.onDeskAction?.();
        const preview = result.text.slice(0, 1500);
        return textResult(
          `Sweep finished for ${projectId}.\n\n${preview}${result.text.length > 1500 ? "…" : ""}`,
        );
      } catch (e) {
        return textResult(`kettle_sweep error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async prepareInvocation() {
      return {
        invocationMessage: "Run Kettle sweep (commit pass)…",
        confirmationMessages: {
          title: "Sweep project?",
          message: new vscode.MarkdownString(
            "Runs the **commit pass** for the sitting. Distinct from Approve (bookmark only).",
          ),
        },
      };
    },
  });
}
