/**
 * Resolve which localhost core to talk to.
 *
 * Order: configured baseUrl → ~/.cache/kettle/server.json → default :4242.
 * Each candidate is validated with GET /api/ping (app === "kettle", matching port).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ping, KettleApi, KettleApiError, readDiscoveryToken } from "./api";
import {
  KettleCompatibilityError,
  assertCoreCompatibility,
} from "./compatibility";

const DEFAULT_URL = "http://127.0.0.1:4242";

export function runtimeCachePath(): string {
  return path.join(os.homedir(), ".cache", "kettle", "server.json");
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/?$/, "");
}

function candidatesFromRuntime(): string[] {
  try {
    const raw = fs.readFileSync(runtimeCachePath(), "utf8");
    const data = JSON.parse(raw) as { port?: number; url?: string };
    if (typeof data.url === "string" && /^https?:\/\//.test(data.url)) {
      return [normalizeBase(data.url)];
    }
    if (typeof data.port === "number" && data.port > 0) {
      return [`http://127.0.0.1:${data.port}`];
    }
  } catch {
    /* missing or unreadable */
  }
  return [];
}

export function discoveryCandidates(configured: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    const n = normalizeBase(u);
    if (n && !out.includes(n)) out.push(n);
  };
  if (configured.trim()) push(configured);
  for (const u of candidatesFromRuntime()) push(u);
  push(DEFAULT_URL);
  return out;
}

export async function resolveCoreBaseUrl(configured: string): Promise<{
  baseUrl: string;
  ping: Ping;
  source: "configured" | "runtime" | "default";
}> {
  const configuredN = configured.trim() ? normalizeBase(configured) : "";
  const runtimeUrls = new Set(candidatesFromRuntime());
  const tried: string[] = [];
  let incompatible: KettleCompatibilityError | undefined;

  for (const base of discoveryCandidates(configured)) {
    tried.push(base);
    try {
      const ping = await new KettleApi(base, readDiscoveryToken()).ping();
      if (ping.app !== "kettle" && ping.app !== "setsweep") continue;
      const urlPort = Number(new URL(base).port);
      if (!urlPort || ping.port !== urlPort) continue;
      assertCoreCompatibility(ping);

      let source: "configured" | "runtime" | "default" = "default";
      if (configuredN && base === configuredN) source = "configured";
      else if (runtimeUrls.has(base)) source = "runtime";
      return { baseUrl: base, ping, source };
    } catch (error) {
      // An explicitly versioned but unsupported core must not be skipped in
      // favor of another port or replaced by auto-start. A stale runtime-cache
      // candidate may be skipped so the canonical default port can still win.
      if (error instanceof KettleCompatibilityError) {
        if (configuredN && base === configuredN) throw error;
        incompatible ??= error;
      }
      /* try next */
    }
  }

  if (incompatible) throw incompatible;
  throw new KettleApiError(
    `Kettle core not reachable (tried ${tried.join(", ")}). ` +
      "Start Kettle.app or `kettle --web`.",
  );
}
