/**
 * src/shared/systemReadiness.ts
 * Core contracts and data structures for System Readiness & Preflight Health Check.
 */

export type PrerequisiteId =
  | "git"
  | "node"
  | "docker"
  | "antigravity"
  | "openai"
  | "codegraph";

export type InstallablePrerequisiteId = Extract<
  PrerequisiteId,
  "antigravity" | "codegraph"
>;

export type ReadinessState =
  | "ready"
  | "missing"
  | "outdated"
  | "stopped"
  | "unavailable";

export interface PrerequisiteReadiness {
  readonly id: PrerequisiteId;
  readonly state: ReadinessState;
  readonly version?: string | undefined;
  readonly detail: string;
  readonly copyCommand?: string | undefined;
  readonly maskedPreview?: string | undefined;
}

export interface SystemReadinessSnapshot {
  readonly checkedAt: number;
  readonly prerequisites: readonly PrerequisiteReadiness[];
  readonly ready: boolean;
}

export interface SystemReadinessApi {
  refresh(): Promise<SystemReadinessSnapshot>;
  onChanged(
    listener: (snapshot: SystemReadinessSnapshot) => void
  ): () => void;
  exitApp(): Promise<void>;
  executeInTerminal(id: InstallablePrerequisiteId): Promise<void>;
}
