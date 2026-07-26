import * as fs from "node:fs";
import * as path from "node:path";
import type { Ping } from "./api";

export type CompatibilityManifest = {
  api_versions: number[];
  desk_schema_versions: number[];
  allow_legacy_identity: boolean;
};

export type CompatibilityResult = {
  ok: boolean;
  legacy: boolean;
  message?: string;
};

let cachedManifest: CompatibilityManifest | undefined;

function isVersionList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => Number.isInteger(v) && v >= 0)
  );
}

export function compatibilityManifest(): CompatibilityManifest {
  if (cachedManifest) return cachedManifest;
  const file = path.resolve(__dirname, "..", "kettle-compatibility.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CompatibilityManifest>;
  if (
    !isVersionList(parsed.api_versions) ||
    !isVersionList(parsed.desk_schema_versions) ||
    typeof parsed.allow_legacy_identity !== "boolean"
  ) {
    throw new Error(`Invalid Kettle compatibility declaration: ${file}`);
  }
  cachedManifest = {
    api_versions: [...new Set(parsed.api_versions)],
    desk_schema_versions: [...new Set(parsed.desk_schema_versions)],
    allow_legacy_identity: parsed.allow_legacy_identity,
  };
  return cachedManifest;
}

export function checkCoreCompatibility(
  ping: Pick<Ping, "version" | "api_version" | "desk_schema_version">,
  manifest = compatibilityManifest(),
): CompatibilityResult {
  const hasApi = ping.api_version != null;
  const hasDesk = ping.desk_schema_version != null;

  if (!hasApi && !hasDesk) {
    return manifest.allow_legacy_identity
      ? {
          ok: true,
          legacy: true,
          message:
            "Core does not publish contract versions; compatibility is assumed for this legacy build.",
        }
      : {
          ok: false,
          legacy: true,
          message:
            "Core does not publish API and desk-schema versions; update kettle-core.",
        };
  }

  // A partially versioned identity is not a legacy core. It is a broken rollout
  // and must not be silently accepted as compatible.
  if (!hasApi || !hasDesk) {
    return {
      ok: false,
      legacy: false,
      message:
        "Core publishes an incomplete contract identity; expected both api_version and desk_schema_version.",
    };
  }

  if (!manifest.api_versions.includes(ping.api_version!)) {
    return {
      ok: false,
      legacy: false,
      message:
        `Core ${ping.version || "unknown"} uses API ${ping.api_version}; ` +
        `this viewport supports ${manifest.api_versions.join(", ")}.`,
    };
  }
  if (!manifest.desk_schema_versions.includes(ping.desk_schema_version!)) {
    return {
      ok: false,
      legacy: false,
      message:
        `Core ${ping.version || "unknown"} uses desk schema ${ping.desk_schema_version}; ` +
        `this viewport supports ${manifest.desk_schema_versions.join(", ")}.`,
    };
  }
  return { ok: true, legacy: false };
}

export class KettleCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KettleCompatibilityError";
  }
}

export function assertCoreCompatibility(
  ping: Pick<Ping, "version" | "api_version" | "desk_schema_version">,
): CompatibilityResult {
  const result = checkCoreCompatibility(ping);
  if (!result.ok) {
    throw new KettleCompatibilityError(result.message || "Incompatible Kettle core.");
  }
  return result;
}
