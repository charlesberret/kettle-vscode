/**
 * Core attach + auto-start.
 *
 * Product default: launching the plugin starts the live core if none is reachable
 * (port 4242 preferred so every viewport shares one desk server). Only kill a
 * process we spawned onto an ephemeral port; a 4242 "live" core is shared
 * infrastructure and survives extension deactivate.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { KettleApi } from "./api";

export type SidecarState = {
  baseUrl: string;
  /** Set only when we own an ephemeral spawn; null for attach or shared :4242. */
  ownedProcess: ChildProcess | null;
};

const DEFAULT_PORT = 4242;

function sidecarEnv(): NodeJS.ProcessEnv {
  // Prefer user/venv shims over Homebrew so editable installs stay current.
  // During Setsweep → Kettle transition, also search the legacy venv.
  const extra = [
    path.join(os.homedir(), ".kettle-venv/bin"),
    path.join(os.homedir(), ".setsweep-venv/bin"),
    path.join(os.homedir(), ".local/bin"),
    path.join(os.homedir(), ".pyenv/shims"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const current = process.env.PATH ?? "";
  return { ...process.env, PATH: [...extra, current].join(path.delimiter) };
}

/**
 * Resolve the CLI used to spawn core. Absolute config wins; otherwise try the
 * canonical venv, legacy setsweep install, then ~/.local/bin, then PATH.
 */
export function resolveKettleCommand(configured: string): string {
  const raw = (configured || "kettle").trim() || "kettle";
  if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  if (raw.startsWith("~/")) {
    const expanded = path.join(os.homedir(), raw.slice(2));
    if (fs.existsSync(expanded)) return expanded;
  }
  const candidates = [
    path.join(os.homedir(), ".kettle-venv", "bin", "kettle"),
    path.join(os.homedir(), ".local", "bin", "kettle"),
    // Transitional: dogfood against pre-rename core
    path.join(os.homedir(), ".setsweep-venv", "bin", "setsweep"),
    path.join(os.homedir(), ".local", "bin", "setsweep"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return raw;
}

/** Accept the legacy identity during the compatibility window. */
function isKettleFamilyApp(app: unknown): boolean {
  return app === "kettle" || app === "setsweep";
}

async function ping(baseUrl: string, expectedPort?: number): Promise<boolean> {
  try {
    const p = await new KettleApi(baseUrl).ping();
    if (!isKettleFamilyApp(p.app)) return false;
    if (expectedPort != null && p.port !== expectedPort) return false;
    return true;
  } catch {
    return false;
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      srv.unref();
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForPing(
  baseUrl: string,
  timeoutMs = 20000,
  expectedPort?: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping(baseUrl, expectedPort)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Kettle core did not become ready at ${baseUrl}`);
}

function waitForSpawnReady(
  child: ChildProcess,
  baseUrl: string,
  expectedPort: number,
  command: string,
  timeoutMs = 20000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed && child.pid) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      reject(err);
    };

    const onError = (err: Error) => {
      fail(
        new Error(
          `Failed to start Kettle via kettle.command "${command}". ` +
            `Install core (` +
            "`pip install -e .` into ~/.kettle-venv) or set kettle.command to the " +
            `absolute path of kettle. Original: ${err.message}`,
        ),
      );
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `Kettle exited before becoming ready (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
            `Check kettle.command (${command}) and that Python 3.11+ is available.`,
        ),
      );
    };

    child.on("error", onError);
    child.on("exit", onExit);

    waitForPing(baseUrl, timeoutMs, expectedPort)
      .then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      })
      .catch(fail);
  });
}

function spawnCore(command: string, port: number, replace = false): ChildProcess {
  const args = ["--web", "--port", String(port), "--no-open"];
  if (replace) args.push("--replace");
  // Detached + unref: core is machine-local infrastructure; closing Cursor
  // must not take the desk offline for the browser or the next session.
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
    env: sidecarEnv(),
  });
  child.unref();
  return child;
}

/** Attach to healthy core at preferredUrl, or spawn the live core (default :4242). */
export async function ensureCore(opts: {
  preferredUrl: string;
  command: string;
  /** When false, only attach — never spawn. Product default is true. */
  autoStart?: boolean;
}): Promise<SidecarState> {
  const preferredPort = portFromBaseUrl(opts.preferredUrl) ?? DEFAULT_PORT;
  const preferredUrl =
    portFromBaseUrl(opts.preferredUrl) != null
      ? opts.preferredUrl.replace(/\/$/, "")
      : `http://127.0.0.1:${preferredPort}`;

  if (await ping(preferredUrl, preferredPort)) {
    return { baseUrl: preferredUrl, ownedProcess: null };
  }

  if (opts.autoStart === false) {
    throw new Error(
      `Kettle core not reachable at ${preferredUrl}. ` +
        "Start `kettle --web` or re-enable kettle.autoStartServer.",
    );
  }

  const command = resolveKettleCommand(opts.command);

  // 1) Live core on the preferred port (4242) — shared by plugin, browser, CLI.
  try {
    const child = spawnCore(command, preferredPort, false);
    await waitForSpawnReady(child, preferredUrl, preferredPort, command);
    return { baseUrl: preferredUrl, ownedProcess: null };
  } catch (firstErr) {
    // Prefer-port failed: maybe a half-dead occupant — try --replace once.
    try {
      const child = spawnCore(command, preferredPort, true);
      await waitForSpawnReady(child, preferredUrl, preferredPort, command, 30000);
      return { baseUrl: preferredUrl, ownedProcess: null };
    } catch {
      // 2) Last resort: ephemeral port (foreign process owns 4242).
      const port = await findFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const child = spawnCore(command, port, false);
      try {
        await waitForSpawnReady(child, baseUrl, port, command);
        // Ephemeral: track so deactivate can clean up if needed; still detached.
        return { baseUrl, ownedProcess: child };
      } catch (ephemeralErr) {
        throw new Error(
          `Could not start Kettle core (preferred ${preferredUrl}, then free port). ` +
            `Preferred error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}. ` +
            `Fallback: ${ephemeralErr instanceof Error ? ephemeralErr.message : String(ephemeralErr)}`,
        );
      }
    }
  }
}

/** Port from a kettle base URL, or null if not parseable. */
export function portFromBaseUrl(baseUrl: string): number | null {
  try {
    const u = new URL(baseUrl);
    if (u.port) {
      const n = parseInt(u.port, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (u.protocol === "https:") return 443;
    if (u.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}

/**
 * Force-restart core so server/static/prompt changes load.
 * Uses --replace on the preferred (live) port.
 */
export async function restartCore(opts: {
  preferredUrl: string;
  command: string;
  previous?: SidecarState;
}): Promise<SidecarState> {
  disposeSidecar(opts.previous);

  const port = portFromBaseUrl(opts.preferredUrl) ?? DEFAULT_PORT;
  const baseUrl =
    portFromBaseUrl(opts.preferredUrl) != null
      ? opts.preferredUrl.replace(/\/$/, "")
      : `http://127.0.0.1:${port}`;
  const command = resolveKettleCommand(opts.command);

  const child = spawnCore(command, port, true);
  await waitForSpawnReady(child, baseUrl, port, command, 30000);
  return { baseUrl, ownedProcess: null };
}

/**
 * Only kill processes we marked as owned (ephemeral ports).
 * Never kill a pre-existing or shared :4242 live core.
 */
export function disposeSidecar(state: SidecarState | undefined): void {
  // Only ephemeral spawns are owned. Shared :4242 cores use ownedProcess=null.
  if (state?.ownedProcess && !state.ownedProcess.killed) {
    try {
      state.ownedProcess.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
