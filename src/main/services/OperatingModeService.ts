/**
 * src/main/services/OperatingModeService.ts
 * Main Process Authority for Tri-State Operating Modes (Discussion / Tweak / Loop).
 * Manages monotonic revision state, updates signed HMAC registry on changes,
 * and emits events for IPC broadcasting to Cockpit UI.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import { EventEmitter } from "node:events";
import type {
  OperatingMode,
  OperatingModeSnapshot,
  ModeChangeRequest,
  TweakScope
} from "../../shared/operatingMode.js";
import { DEFAULT_OPERATING_MODE } from "../../shared/operatingMode.js";
import { canonicalizePath } from "./blueprintApprovalAuthenticator.js";
import {
  PreToolUseHookService,
  resolveDefaultUserDataPath
} from "./preToolUseHookService.js";
import {
  computeRegistryEntryHmac,
  type WorkspaceRegistryFile,
  type WorkspaceRegistryEntry
} from "./preToolUseRegistryHmac.js";

export class OperatingModeService extends EventEmitter {
  private static instance: OperatingModeService | null = null;
  private readonly snapshots = new Map<string, OperatingModeSnapshot>();
  private readonly transitionLocks = new Map<string, Promise<OperatingModeSnapshot>>();
  private readonly userDataPath: string;

  constructor(userDataPath?: string) {
    super();
    this.userDataPath = userDataPath ?? resolveDefaultUserDataPath();
  }

  static getInstance(userDataPath?: string): OperatingModeService {
    if (!OperatingModeService.instance) {
      OperatingModeService.instance = new OperatingModeService(userDataPath);
    }
    return OperatingModeService.instance;
  }

  static resetInstance(): void {
    OperatingModeService.instance = null;
  }

  getSnapshot(workspacePath: string): OperatingModeSnapshot {
    const canonical = canonicalizePath(workspacePath);
    const existing = this.snapshots.get(canonical);
    if (existing) {
      return existing;
    }

    // Attempt to restore snapshot from signed workspace registry if present
    const registryPath = path.join(this.userDataPath, "hooks", "workspaces.json");
    try {
      if (syncFs.existsSync(registryPath)) {
        const raw = syncFs.readFileSync(registryPath, "utf-8");
        const registry: WorkspaceRegistryFile = JSON.parse(raw);
        const entry = registry.workspaces?.[canonical];
        if (entry && entry.operatingMode) {
          const restored: OperatingModeSnapshot = {
            workspaceId: canonical,
            mode: entry.operatingMode,
            revision: entry.authorizationRevision ?? 1,
            ...(entry.tweakScope ? { tweakScope: entry.tweakScope } : {})
          };
          this.snapshots.set(canonical, restored);
          return restored;
        }
      }
    } catch {
      // Non-fatal fallback
    }

    const defaultSnapshot: OperatingModeSnapshot = {
      workspaceId: canonical,
      mode: DEFAULT_OPERATING_MODE,
      revision: 1
    };
    this.snapshots.set(canonical, defaultSnapshot);
    return defaultSnapshot;
  }

  async setMode(request: ModeChangeRequest): Promise<OperatingModeSnapshot> {
    const canonical = canonicalizePath(request.workspaceId);

    const currentLock = (
      this.transitionLocks.get(canonical) ?? Promise.resolve(this.getSnapshot(canonical))
    ).catch(() => this.getSnapshot(canonical));

    const operation = currentLock.then(async () => {
      const current = this.getSnapshot(canonical);

      if (request.expectedRevision !== current.revision) {
        throw new Error(
          `Revision conflict: expected revision ${request.expectedRevision}, but current revision is ${current.revision}`
        );
      }

      const nextRevision = current.revision + 1;
      const updatedSnapshot: OperatingModeSnapshot = {
        workspaceId: canonical,
        mode: request.mode,
        revision: nextRevision,
        ...(request.tweakScope ? { tweakScope: request.tweakScope } : {})
      };

      this.snapshots.set(canonical, updatedSnapshot);

      await this.persistToHmacRegistry(canonical, updatedSnapshot);

      this.emit("modeChanged", updatedSnapshot);
      return updatedSnapshot;
    });

    this.transitionLocks.set(
      canonical,
      operation.catch(() => this.getSnapshot(canonical))
    );
    return operation;
  }

  private async persistToHmacRegistry(
    canonicalWorkspace: string,
    snapshot: OperatingModeSnapshot
  ): Promise<void> {
    const registryPath = path.join(this.userDataPath, "hooks", "workspaces.json");
    try {
      if (!syncFs.existsSync(registryPath)) return;
      const signingKey = await PreToolUseHookService.getOrCreateSigningKey(this.userDataPath);

      const raw = await fs.readFile(registryPath, "utf-8");
      const registry: WorkspaceRegistryFile = JSON.parse(raw);
      if (!registry.workspaces) return;

      const existingEntry = registry.workspaces[canonicalWorkspace];
      if (!existingEntry) return;

      const { tweakScope: _discard, ...rest } = existingEntry;
      const updatedBase: WorkspaceRegistryEntry = {
        ...rest,
        schemaVersion: 2,
        operatingMode: snapshot.mode,
        authorizationRevision: snapshot.revision,
        ...(snapshot.tweakScope ? { tweakScope: snapshot.tweakScope } : {})
      };

      const entryHmac = computeRegistryEntryHmac(updatedBase, signingKey);
      registry.workspaces[canonicalWorkspace] = {
        ...updatedBase,
        entryHmac
      };

      const tmpPath = `${registryPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
      await fs.rename(tmpPath, registryPath);
    } catch {
      // Non-fatal if registry is not yet initialized
    }
  }
}
