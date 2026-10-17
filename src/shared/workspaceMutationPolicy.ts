/**
 * src/shared/workspaceMutationPolicy.ts
 * Pure, side-effect-free evaluator for workspace mutation permissions.
 * Shared across in-process WorkspaceWriteGuard and external Antigravity PreToolUse CLI Hook.
 */

import * as path from "node:path";
import type { LoopState } from "../engine.js";

export type WorkspaceMutationPolicyMode =
  | "strict"
  | "documentation-fast-path";

export interface WorkspaceMutationPolicyResult {
  readonly allowed: boolean;
  readonly reason: string;
  readonly isFastPath?: boolean;
}

export function isPathInside(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Evaluates whether a workspace-relative normalized path qualifies as an inert documentation target.
 * Hard-blocks sensitive prompt/instruction documents (AGENTS.md, GEMINI.md, CLAUDE.md)
 * and core specification/loop contracts (docs/LOOP.md).
 */
export function isSafeDocumentationTarget(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").trim();
  const basename = path.posix.basename(normalized).toLowerCase();

  // 1. Invariant: Agent instruction and prompt definition files are NEVER exempt
  if (basename === "agents.md" || basename === "gemini.md" || basename === "claude.md") {
    return false;
  }

  // 2. Invariant: Core loop specification and acceptance criteria are NEVER exempt
  if (normalized.toLowerCase() === "docs/loop.md" || normalized.toLowerCase().endsWith("/loop.md")) {
    return false;
  }

  // 3. Root README file
  if (normalized.toLowerCase() === "readme.md") {
    return true;
  }

  // 4. Root license files
  if (basename === "license" || basename === "license.txt" || basename === "license.md") {
    return true;
  }

  // 5. Safe documentation below docs/ (excluding loop.md)
  if (normalized.toLowerCase().startsWith("docs/")) {
    return normalized.endsWith(".md") || normalized.endsWith(".txt");
  }

  return false;
}

export function evaluateWorkspaceMutationPolicy(
  state: LoopState,
  targetPaths: readonly string[],
  workspaceRoot: string = process.cwd(),
  mode: WorkspaceMutationPolicyMode = "strict"
): WorkspaceMutationPolicyResult {
  if (!targetPaths || targetPaths.length === 0) {
    return {
      allowed: false,
      reason: "Mutation denied: targetPaths must contain at least one path"
    };
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  const evalDir = path.resolve(normalizedRoot, ".eval");
  const blueprintFile = path.resolve(normalizedRoot, ".ai/blueprint.md");

  // Normalize requested paths
  const resolvedPaths = targetPaths.map((p) => path.resolve(normalizedRoot, p));

  // 1. Workspace escape check: paths must not escape workspace root
  for (const resolved of resolvedPaths) {
    const rel = path.relative(normalizedRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        allowed: false,
        reason: `Mutation denied: target path '${resolved}' escapes the workspace root`
      };
    }
  }

  // 2. Invariant: .eval/ is STRICTLY READ-ONLY in all phases and modes
  for (const resolved of resolvedPaths) {
    if (resolved === evalDir || isPathInside(resolved, evalDir)) {
      return {
        allowed: false,
        reason: `Mutation denied: path '${resolved}' is inside protected evaluation directory (.eval/)`
      };
    }
  }

  // 3. Invariant: .ai/blueprint.md is immutable in all phases and modes once committed
  for (const resolved of resolvedPaths) {
    if (resolved === blueprintFile) {
      return {
        allowed: false,
        reason: "Mutation denied: .ai/blueprint.md is an immutable Stage 2 artifact and cannot be modified"
      };
    }
  }

  // 4. Documentation Fast Path evaluation
  if (mode === "documentation-fast-path") {
    const allAreSafeDocs = resolvedPaths.every((resolved) => {
      const rel = path.relative(normalizedRoot, resolved);
      return isSafeDocumentationTarget(rel);
    });

    if (allAreSafeDocs) {
      return {
        allowed: true,
        isFastPath: true,
        reason: "Documentation fast path permitted: safe documentation target"
      };
    }
  }

  // 5. Phase check: Non-exempt workspace mutations only permitted in EXECUTE
  if (state.currentPhase !== "EXECUTE") {
    return {
      allowed: false,
      reason: `Mutation denied: workspace modifications are only permitted during EXECUTE phase (current phase: '${state.currentPhase}')`
    };
  }

  // 6. Blueprint check: Even in EXECUTE, blueprint must be ready
  if (!state.blueprint || state.blueprint.status !== "ready") {
    return {
      allowed: false,
      reason: `Mutation denied: valid ready blueprint required before modifying workspace (current status: '${state.blueprint?.status ?? "none"}')`
    };
  }

  return {
    allowed: true,
    isFastPath: false,
    reason: "Mutation permitted: valid blueprint and active EXECUTE phase"
  };
}

import type {
  OperatingMode,
  TweakScope,
  OperatingModeMutationResult
} from "./operatingMode.js";
import { TWEAK_CONSTRAINTS } from "./operatingMode.js";

export interface OperatingModeMutationContext {
  readonly mode: OperatingMode;
  readonly authorizationRevision?: number | undefined;
  readonly activeRevision?: number | undefined;
  readonly tweakScope?: TweakScope | undefined;
  readonly proposedLineCount?: number | undefined;
}

const TWEAK_PROTECTED_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.node.json"
]);

export function isTweakProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").trim().toLowerCase();
  const basename = path.posix.basename(normalized);

  if (normalized.startsWith(".eval/") || normalized === ".eval") return true;
  if (normalized.startsWith(".git/") || normalized === ".git") return true;
  if (normalized.startsWith(".ai/") || normalized === ".ai") return true;
  if (TWEAK_PROTECTED_BASENAMES.has(basename)) return true;

  return false;
}

export function evaluateOperatingModeMutationPolicy(
  context: OperatingModeMutationContext,
  targetPaths: readonly string[],
  workspaceRoot: string = process.cwd()
): OperatingModeMutationResult {
  const mode = context.mode;

  if (!targetPaths || targetPaths.length === 0) {
    return {
      allowed: false,
      mode,
      reason: "Mutation denied: targetPaths must contain at least one path"
    };
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  const evalDir = path.resolve(normalizedRoot, ".eval");
  const resolvedPaths = targetPaths.map((p) => path.resolve(normalizedRoot, p));

  // 1. Workspace containment
  for (const resolved of resolvedPaths) {
    const rel = path.relative(normalizedRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        allowed: false,
        mode,
        reason: `Mutation denied: target path '${resolved}' escapes workspace root`,
        rejectionCode: "PROTECTED_PATH"
      };
    }
  }

  // 2. Invariant: .eval/ is strictly read-only in every mode
  for (const resolved of resolvedPaths) {
    if (resolved === evalDir || isPathInside(resolved, evalDir)) {
      return {
        allowed: false,
        mode,
        reason: `Mutation denied: path '${resolved}' is inside protected evaluation directory (.eval/)`,
        rejectionCode: "PROTECTED_PATH"
      };
    }
  }

  // 3. Discussion mode: 100% read-only
  if (mode === "discussion") {
    return {
      allowed: false,
      mode: "discussion",
      reason: "Chế độ Thảo luận (Discussion) là Read-only. Không được phép chỉnh sửa tập tin.",
      rejectionCode: "DISCUSSION_READONLY"
    };
  }

  // 4. Tweak mode: bounded mutation transaction
  if (mode === "tweak") {
    // Check line budget ceiling
    const maxLineBudget = context.tweakScope?.maxLineBudget ?? TWEAK_CONSTRAINTS.MAX_LINE_BUDGET;
    if (context.proposedLineCount !== undefined && context.proposedLineCount > maxLineBudget) {
      return {
        allowed: false,
        mode: "tweak",
        reason: `Chế độ Tinh chỉnh (Tweak) giới hạn tối đa ${maxLineBudget} dòng thay đổi (thay đổi đề xuất: ${context.proposedLineCount} dòng). Vui lòng dùng Loop.`,
        rejectionCode: "TWEAK_BUDGET_EXCEEDED"
      };
    }

    // Check file count ceiling
    const maxFiles = context.tweakScope?.maxFiles ?? TWEAK_CONSTRAINTS.MAX_FILES;
    if (targetPaths.length > maxFiles) {
      return {
        allowed: false,
        mode: "tweak",
        reason: `Chế độ Tinh chỉnh (Tweak) giới hạn tối đa ${maxFiles} tập tin (yêu cầu: ${targetPaths.length}). Vui lòng dùng Loop.`,
        rejectionCode: "TWEAK_FILE_LIMIT_EXCEEDED"
      };
    }

    // Check protected files for tweak
    for (const resolved of resolvedPaths) {
      const rel = path.relative(normalizedRoot, resolved);
      if (isTweakProtectedPath(rel)) {
        return {
          allowed: false,
          mode: "tweak",
          reason: `Chế độ Tinh chỉnh (Tweak) không được phép sửa tập tin nhạy cảm: '${rel}'. Vui lòng dùng Loop.`,
          rejectionCode: "PROTECTED_PATH"
        };
      }
    }

    // If a tweak scope is configured, enforce strict path whitelist & expiration
    if (context.tweakScope) {
      if (context.tweakScope.expiresAtMs && Date.now() > context.tweakScope.expiresAtMs) {
        return {
          allowed: false,
          mode: "tweak",
          reason: "Phiên giao dịch Tinh chỉnh (Tweak) đã hết hạn. Vui lòng phê duyệt lại.",
          rejectionCode: "TRANSACTION_EXPIRED"
        };
      }

      const allowedSet = new Set(
        context.tweakScope.allowedRelativePaths.map((p) => p.replace(/\\/g, "/").toLowerCase())
      );

      for (const resolved of resolvedPaths) {
        const rel = path.relative(normalizedRoot, resolved).replace(/\\/g, "/").toLowerCase();
        if (!allowedSet.has(rel)) {
          return {
            allowed: false,
            mode: "tweak",
            reason: `Tập tin '${rel}' không nằm trong phạm vi được phê duyệt của phiên Tinh chỉnh.`,
            rejectionCode: "TWEAK_PATH_UNAPPROVED"
          };
        }
      }
    }

    return {
      allowed: true,
      mode: "tweak",
      reason: "Tinh chỉnh (Tweak) được chấp thuận trong phạm vi được ủy quyền."
    };
  }

  // 5. Loop mode: pass-through to loop policy
  return {
    allowed: true,
    mode: "loop",
    reason: "Chế độ Loop đang hoạt động: ủy quyền cho quy trình tự trị 10 pha."
  };
}

