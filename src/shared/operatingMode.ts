/**
 * src/shared/operatingMode.ts
 * Tri-State Operating Switch contracts & data models:
 * - "discussion": Read-only conversational mode; zero workspace mutations permitted.
 * - "tweak": Bounded mutation transaction; local CPU verification; zero GPT Oracle calls.
 * - "loop": Full Autonomous Loop v3.0 pipeline with Blueprint & Stage 4 Adversarial Audit.
 */

export type OperatingMode = "discussion" | "tweak" | "loop";

export const OPERATING_MODE_LABELS: Record<OperatingMode, string> = {
  discussion: "Discussion",
  tweak: "Tweak",
  loop: "Loop"
} as const;

export const DEFAULT_OPERATING_MODE: OperatingMode = "loop";

export const TWEAK_CONSTRAINTS = {
  MAX_FILES: 3,
  MAX_LINE_BUDGET: 120,
  TRANSACTION_TIMEOUT_MS: 10 * 60 * 1000 // 10 minutes
} as const;

export interface TweakScope {
  readonly transactionId: string;
  readonly allowedRelativePaths: readonly string[];
  readonly maxLineBudget: number;
  readonly maxFiles: number;
  readonly expiresAtMs: number;
}

export interface OperatingModeSnapshot {
  readonly workspaceId: string;
  readonly mode: OperatingMode;
  readonly revision: number;
  readonly tweakScope?: TweakScope | undefined;
}

export interface ModeChangeRequest {
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly mode: OperatingMode;
  readonly tweakScope?: TweakScope | undefined;
}

export type OperatingModeRejectionCode =
  | "DISCUSSION_READONLY"
  | "TWEAK_PATH_UNAPPROVED"
  | "TWEAK_FILE_LIMIT_EXCEEDED"
  | "TWEAK_BUDGET_EXCEEDED"
  | "PROTECTED_PATH"
  | "TRANSACTION_EXPIRED"
  | "REVISION_STALE";

export interface OperatingModeMutationResult {
  readonly allowed: boolean;
  readonly mode: OperatingMode;
  readonly reason: string;
  readonly rejectionCode?: OperatingModeRejectionCode | undefined;
}
