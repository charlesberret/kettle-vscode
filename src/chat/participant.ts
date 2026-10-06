/**
 * @kettle chat participant — queue-aware helper that speaks the panel's words
 * (Approve marks a decision; Finish batch applies them).
 */
import * as vscode from "vscode";
import type { KettleApi } from "../api";
import * as state from "../state";
import { uiCopy } from "../uiCopy";

export type ParticipantDeps = {
  getApi: () => Promise<KettleApi>;
  getProjectId: () => Promise<string | undefined>;
};

export function registerKettleParticipant(
  context: vscode.ExtensionContext,
  deps: ParticipantDeps,
): void {
  const participant = vscode.chat.createChatParticipant(
    "kettle.chat",
    async (request, _chatCtx, stream, _token) => {
      stream.markdown(
        `Kettle helper. **${uiCopy("approveLabel")}** marks your decision on a file; ` +
          `**${uiCopy("sweepLabel")}** applies your decisions and lines up the next files. ` +
          "Use tools `kettle_queue`, `kettle_entry`, `kettle_comment`, `kettle_approve`, `kettle_sweep`.\n\n",
      );

      const q = request.prompt.toLowerCase().trim();
      if (!q || q.includes("queue") || q.includes("next") || q.includes("status")) {
        const projectId = await deps.getProjectId();
        if (!projectId) {
          stream.markdown("No project selected. Run **Kettle: Select Project**.");
          return;
        }
        try {
          if (q.includes("status")) {
            const api = await deps.getApi();
            const ping = await api.ping();
            stream.markdown(
              `Core ok · pid \`${ping.pid}\` · port \`${ping.port}\` · project \`${projectId}\`.\n`,
            );
            if (q === "status") return;
          }
          const api = await deps.getApi();
          const queue = await api.queue(projectId, { mutate: false });
          const entries = queue.entries || [];
          state.setEntries(entries);
          if (!entries.length) {
            stream.markdown("_Queue empty._");
            return;
          }
          const lines = entries.map((e) => {
            const st = e.status || "pending";
            const urg = e.urgency ? ` · ${e.urgency}` : "";
            return `- \`${e.id}\` **${st}** \`${e.path}\`${urg}`;
          });
          stream.markdown(lines.join("\n"));
          const last = state.getLastEntry();
          if (last) {
            stream.markdown(
              `\n\nOpen file: \`${last.path}\` (${last.status || "pending"}).`,
            );
          }
        } catch (e) {
          stream.markdown(
            `Could not load queue: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return;
      }

      if (q.includes("summary") || q.includes("brief") || q.includes("file") || q.includes("entry")) {
        const last = state.getLastEntry();
        if (!last) {
          stream.markdown(
            "No file open. Open a queue file or ask for the **queue** first.",
          );
          return;
        }
        stream.markdown(`### ${last.path}\n\n`);
        if (last.ask) stream.markdown(`**Question:** ${last.ask}\n\n`);
        if (last.brief) stream.markdown(last.brief);
        else stream.markdown("_No summary yet._");
        if (last.comment) stream.markdown(`\n\n**Comment:** ${last.comment}`);
        if (last.diff && (last.diff.added || last.diff.removed)) {
          stream.markdown(`\n\nDiff vs snapshot: +${last.diff.added} −${last.diff.removed}`);
        }
        return;
      }

      stream.markdown(
        "Try: *queue*, *status*, *summary*, or invoke tools " +
          "`kettle_queue` / `kettle_entry` / `kettle_comment` / `kettle_approve` / `kettle_sweep`.",
      );
    },
  );

  participant.iconPath = new vscode.ThemeIcon("checklist");
  context.subscriptions.push(participant);
}
