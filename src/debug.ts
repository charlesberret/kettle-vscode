/**
 * Kettle diagnostics — Output channel + on-disk log for agents and users.
 *
 * BUILD_ID is derived from package.json version (single source of truth).
 *
 * Logs go to:
 * 1. VS Code/Cursor Output channel "Kettle Debug"
 * 2. ~/.cache/kettle/plugin-debug.log  (readable without the IDE)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) return String(pkg.version);
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

/** Matches package.json version — Desk header uses the same value. */
export const BUILD_ID = readPackageVersion();

/** On-disk mirror so tools/agents can `cat` logs without the Output panel. */
export function logFilePath(): string {
  return path.join(os.homedir(), ".cache", "kettle", "plugin-debug.log");
}

export type ExtensionIdentity = {
  id: string;
  version: string;
  buildId: string;
  extensionPath: string;
  main: string;
  isDevHost: boolean;
  isSymlinkHint: boolean;
  appName: string;
};

let channel: vscode.OutputChannel | undefined;
let lastIdentity: ExtensionIdentity | undefined;
let logFileReady = false;

function ensureLogFile(): void {
  if (logFileReady) return;
  try {
    fs.mkdirSync(path.dirname(logFilePath()), { recursive: true });
    logFileReady = true;
  } catch {
    /* disk logging optional */
  }
}

function appendLogFile(line: string): void {
  try {
    ensureLogFile();
    fs.appendFileSync(logFilePath(), line + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

export function getIdentity(context: vscode.ExtensionContext): ExtensionIdentity {
  const pkg = context.extension.packageJSON || {};
  const version = String(pkg.version || BUILD_ID || "unknown");
  const id = context.extension.id || `${pkg.publisher || "?"}.${pkg.name || "kettle"}`;
  const extensionPath = context.extensionUri.fsPath;
  const main = String(pkg.main || "");
  return {
    id,
    version,
    buildId: BUILD_ID || version,
    extensionPath,
    main,
    isDevHost: /Extension Development Host/i.test(vscode.env.appName || ""),
    isSymlinkHint: /kettle-dev|Repos\/kettle|link-dev/i.test(extensionPath),
    appName: vscode.env.appName || "vscode",
  };
}

export function ensureChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Kettle Debug");
  }
  return channel;
}

/** Log one line to Output + ~/.cache/kettle/plugin-debug.log */
export function log(line: string): void {
  const ch = ensureChannel();
  const ts = new Date().toISOString().slice(11, 23);
  const stamped = `[${ts}] ${line}`;
  ch.appendLine(stamped);
  appendLogFile(stamped);
}

/** Log a multi-line block (each line stamped). */
export function logBlock(text: string): void {
  for (const line of text.split("\n")) {
    log(line);
  }
}

export function logActivate(context: vscode.ExtensionContext): ExtensionIdentity {
  lastIdentity = getIdentity(context);
  const i = lastIdentity;
  log("—— activate ——");
  log(`extension.id      ${i.id}`);
  log(`package.version   ${i.version}`);
  log(`buildId           ${i.buildId}`);
  log(`extension.path    ${i.extensionPath}`);
  log(`package.main      ${i.main}`);
  log(`host              ${i.appName}`);
  log(`devHost           ${i.isDevHost}`);
  log(`log file          ${logFilePath()}`);
  if (!i.isSymlinkHint && !i.isDevHost) {
    log("NOTE: Installed VSIX snapshot (not link-dev). Workspace edits under");
    log("      Repos/kettle-plugin apply only after package/install or link-dev.");
  }
  void vscode.window.setStatusBarMessage(`Kettle ${i.version} · ${i.buildId}`, 8000);
  return i;
}

export function logDesk(event: string, detail?: unknown): void {
  if (detail != null && typeof detail === "object") {
    try {
      log(`desk.${event} ${JSON.stringify(detail)}`);
      return;
    } catch {
      /* fall through */
    }
  }
  log(`desk.${event}${detail != null ? " " + String(detail) : ""}`);
}

export function showDebugChannel(): void {
  ensureChannel().show(true);
}

/** Identity snapshot for the unified Debug command. */
export function logIdentitySnapshot(): void {
  if (lastIdentity) {
    log("—— identity ——");
    log(`extension.id      ${lastIdentity.id}`);
    log(`package.version   ${lastIdentity.version}`);
    log(`buildId           ${lastIdentity.buildId}`);
    log(`extension.path    ${lastIdentity.extensionPath}`);
    log(`host              ${lastIdentity.appName}`);
  } else {
    log("—— identity (not activated yet) ——");
  }
  log(`log file          ${logFilePath()}`);
}

export function disposeDebug(): void {
  channel?.dispose();
  channel = undefined;
}
