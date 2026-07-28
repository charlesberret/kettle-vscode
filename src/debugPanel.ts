/**
 * Kettle Debug — a live-updating log/error panel, separate from the Desk.
 *
 * Every debug.log()/logBlock() call anywhere in the extension already feeds
 * debug's in-memory ring; this view just mirrors that ring live via
 * onDidLog/onDidClearLog, so no other call site needs to change.
 *
 * "Copy Report" builds a fenced Markdown block (identity + recent lines) sized
 * to paste straight into a coding agent's chat — that's the point of this panel.
 */
import * as vscode from "vscode";
import * as debug from "./debug";

type HostMessage =
  | { type: "ready" }
  | { type: "clear" }
  | { type: "copyAll" }
  | { type: "openLogFile" };

export class DebugPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kettle.debugPanel";

  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = shellHtml();

    const post = (msg: unknown) => void webviewView.webview.postMessage(msg);

    this.disposables.push(
      debug.onDidLog((entry) => post({ type: "append", entry })),
      debug.onDidClearLog(() => post({ type: "clear" })),
      webviewView.webview.onDidReceiveMessage((msg: HostMessage) => {
        switch (msg?.type) {
          case "ready":
            post({ type: "init", lines: debug.getRecentLog() });
            break;
          case "clear":
            debug.clearRecentLog();
            break;
          case "copyAll":
            void vscode.env.clipboard.writeText(debug.buildDebugReport());
            void vscode.window.showInformationMessage(
              "Kettle debug report copied — paste it to your coding agent.",
            );
            break;
          case "openLogFile":
            void vscode.workspace.openTextDocument(debug.logFilePath()).then(
              (doc) => vscode.window.showTextDocument(doc, { preview: false }),
              () =>
                void vscode.window.showWarningMessage(
                  "Kettle log file not found yet — nothing has been logged to disk.",
                ),
            );
            break;
        }
      }),
      webviewView.onDidDispose(() => {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
      }),
    );
  }

  refresh(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: "init", lines: debug.getRecentLog() });
  }
}

function shellHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  #toolbar {
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    flex: none;
  }
  button {
    font: inherit;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, transparent));
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
  #count {
    margin-left: auto;
    align-self: center;
    opacity: 0.7;
    font-size: 0.9em;
  }
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .line { padding: 1px 0; }
  .line.error { color: var(--vscode-errorForeground, #f14c4c); }
  .line.header { opacity: 0.6; }
  .empty { opacity: 0.6; padding: 8px; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="btnCopy" title="Copy identity + recent log lines, ready to paste to a coding agent">Copy Report</button>
  <button id="btnClear" title="Clear this panel (Output channel and disk log are untouched)">Clear</button>
  <button id="btnOpenFile" title="Open ~/.cache/kettle/plugin-debug.log">Open Log File</button>
  <span id="count"></span>
</div>
<div id="log"><div class="empty">No log lines yet this session.</div></div>
<script>
  const vscode = acquireVsCodeApi();
  const logEl = document.getElementById('log');
  const countEl = document.getElementById('count');
  let errorCount = 0;

  function isErrorText(text) {
    return /\\bFAIL\\b|\\berror\\b|\\bfailed\\b|\\bexception\\b/i.test(text);
  }
  function isHeaderText(text) {
    return /——/.test(text);
  }
  function nearBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }
  function updateCount() {
    countEl.textContent = errorCount > 0 ? errorCount + (errorCount === 1 ? ' error' : ' errors') : '';
  }
  function renderLine(entry) {
    const div = document.createElement('div');
    div.className = 'line' + (isErrorText(entry.text) ? ' error' : isHeaderText(entry.text) ? ' header' : '');
    div.textContent = entry.text;
    return div;
  }
  function appendEntry(entry) {
    const stick = nearBottom();
    const empty = logEl.querySelector('.empty');
    if (empty) empty.remove();
    logEl.appendChild(renderLine(entry));
    if (entry.level === 'error') { errorCount++; updateCount(); }
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  function renderAll(lines) {
    logEl.textContent = '';
    errorCount = 0;
    if (!lines.length) {
      logEl.innerHTML = '<div class="empty">No log lines yet this session.</div>';
    } else {
      const frag = document.createDocumentFragment();
      for (const entry of lines) {
        frag.appendChild(renderLine(entry));
        if (entry.level === 'error') errorCount++;
      }
      logEl.appendChild(frag);
    }
    updateCount();
    logEl.scrollTop = logEl.scrollHeight;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'init') renderAll(msg.lines || []);
    else if (msg.type === 'append') appendEntry(msg.entry);
    else if (msg.type === 'clear') renderAll([]);
  });

  document.getElementById('btnCopy').onclick = () => vscode.postMessage({ type: 'copyAll' });
  document.getElementById('btnClear').onclick = () => vscode.postMessage({ type: 'clear' });
  document.getElementById('btnOpenFile').onclick = () => vscode.postMessage({ type: 'openLogFile' });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
