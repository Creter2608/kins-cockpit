/**
 * src/shared/workspaceStatePaths.ts
 * Shared state-path resolution contract for Desktop, CLI, and Lifecycle Hooks.
 * Enforces single source of truth without polluting external repositories.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspaceStateCandidates {
  readonly canonicalWorkspaceRoot: string;
  readonly sidecarStateFile: string;
}

export interface WorkspaceStateResolution {
  readonly stateFile: string;
  readonly source: "legacy" | "sidecar";
  readonly duplicateLegacyFile?: string;
}

function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalizeJson).join(",")}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson((obj as Record<string, unknown>)[k])}`).join(",")}}`;
}

function areJsonStatesEqual(fileA: string, fileB: string): boolean {
  try {
    const rawA = fs.readFileSync(fileA, "utf-8");
    const rawB = fs.readFileSync(fileB, "utf-8");
    const parsedA = JSON.parse(rawA);
    const parsedB = JSON.parse(rawB);
    return canonicalizeJson(parsedA) === canonicalizeJson(parsedB);
  } catch {
    return false;
  }
}

export function resolveWorkspaceStateFile(
  candidates: WorkspaceStateCandidates,
  intent: "read" | "initialize"
): WorkspaceStateResolution {
  const legacyDir = path.resolve(candidates.canonicalWorkspaceRoot, ".ai");
  const legacyStateFile = path.resolve(legacyDir, "state.json");
  const sidecarStateFile = path.resolve(candidates.sidecarStateFile);

  let hasLegacyDir = false;
  try {
    hasLegacyDir = fs.existsSync(legacyDir) && fs.statSync(legacyDir).isDirectory();
  } catch {}

  const hasLegacyFile = fs.existsSync(legacyStateFile);
  const hasLegacy = hasLegacyFile || (intent === "initialize" && hasLegacyDir);
  const hasSidecar = fs.existsSync(sidecarStateFile);

  if (intent === "initialize") {
    if (hasLegacyFile && hasSidecar) {
      if (areJsonStatesEqual(legacyStateFile, sidecarStateFile)) {
        return {
          stateFile: sidecarStateFile,
          source: "sidecar",
          duplicateLegacyFile: legacyStateFile
        };
      }
      throw new Error(
        `STATE_PATH_CONFLICT: Both legacy (${legacyStateFile}) and sidecar (${sidecarStateFile}) state files exist with divergent contents.`
      );
    }
    if (hasSidecar) {
      return { stateFile: sidecarStateFile, source: "sidecar" };
    }
    if (hasLegacy) {
      return { stateFile: legacyStateFile, source: "legacy" };
    }
    // Neither exists -> initialize to sidecar destination without polluting repository
    return { stateFile: sidecarStateFile, source: "sidecar" };
  }

  // intent === "read"
  if (hasSidecar && !hasLegacyFile) {
    return { stateFile: sidecarStateFile, source: "sidecar" };
  }
  if (hasLegacyFile && !hasSidecar) {
    return { stateFile: legacyStateFile, source: "legacy" };
  }
  if (hasLegacyFile && hasSidecar) {
    if (areJsonStatesEqual(legacyStateFile, sidecarStateFile)) {
      return {
        stateFile: sidecarStateFile,
        source: "sidecar",
        duplicateLegacyFile: legacyStateFile
      };
    }
    throw new Error(
      `STATE_PATH_CONFLICT: Both legacy (${legacyStateFile}) and sidecar (${sidecarStateFile}) state files exist with divergent contents.`
    );
  }

  throw new Error(
    `STATE_FILE_NOT_FOUND: Neither sidecar (${sidecarStateFile}) nor legacy (${legacyStateFile}) state file exists.`
  );
}
