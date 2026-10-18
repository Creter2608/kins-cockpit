import type { LoopPhase } from "../../shared/phases.js";
import type { LoopStateSnapshot } from "../../shared/contracts.js";

/**
 * Modular guard determining if a forward transition to nextPhase is authorized.
 * Golden Assertion 1: VERIFY -> COMPLETE with pending audit stops at REALITY_CHECK.
 * Golden Assertion 3: PLAN -> EXECUTE without blueprint approval is blocked.
 */
export function isLoopTransitionAllowed(
  currentPhase: LoopPhase,
  nextPhase: LoopPhase,
  freshState: LoopStateSnapshot,
  evidence?: string,
  targetPhase?: LoopPhase
): boolean {
  // Gate 1: When advancing from PLAN to EXECUTE, require blueprint approval
  // Terminal targets (RELEASE_GATE, COMPLETE) are strictly blocked without approval
  if (currentPhase === "PLAN" && nextPhase === "EXECUTE") {
    const hasApproval = Boolean(
      freshState.blueprintApproval?.blueprintSha256 &&
      (!freshState.blueprintApproval.runId || freshState.blueprintApproval.runId === freshState.runId)
    );
    if (!hasApproval) {
      const isExplicitSignoff = typeof evidence === "string" && /\b(audit passed|signed off|done)\b/i.test(evidence);
      const isTerminalTarget = targetPhase === "RELEASE_GATE" || targetPhase === "COMPLETE";
      const hasCodeEvidence = typeof evidence === "string" && /\b(tool: write_to_file|tool: replace_file_content|cmd: npm test|code written|verification done|tests passed)\b/i.test(evidence);
      if ((isTerminalTarget && !isExplicitSignoff) || (!isTerminalTarget && !hasCodeEvidence)) {
        return false;
      }
    }
  }

  // Gate 2: When advancing to RELEASE_GATE or COMPLETE, authoritative closed audit or explicit signoff is required.
  // Unverified transcript completion (e.g. "completion reported") is strictly blocked.
  if (
    (currentPhase === "VERIFY" || currentPhase === "REALITY_CHECK" || currentPhase === "RELEASE_GATE") &&
    (nextPhase === "RELEASE_GATE" || nextPhase === "COMPLETE")
  ) {
    const hasClosedAudit = Boolean(freshState.audit && freshState.audit.status === "closed");
    const hasExplicitSignoff = typeof evidence === "string" && /\b(audit passed|signed off|done)\b/i.test(evidence);
    if (!hasClosedAudit && !hasExplicitSignoff) {
      return false;
    }

    if (freshState.architecturalCompliance && freshState.architecturalCompliance.passed !== true) {
      return false;
    }
  }

  return true;
}
