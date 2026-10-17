#!/usr/bin/env node

/**
 * scripts/hooks/pre-commit.mjs
 * Deterministic Git Pre-Commit Validator for Kin's Cockpit Autonomous Loop.
 * Enforces fail-closed verification of .ai/state.json:
 * 1. Stage 4 Adversarial Audit status must be 'closed'.
 * 2. Architectural compliance passed must be true (AQI >= 3.5).
 * 3. Loop phase must be RELEASE_GATE or COMPLETE (or status 'succeeded').
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

function fail(reason) {
  fs.writeSync(2, `\n[PRE-COMMIT HOOK REJECTED]: ${reason}\n\n`);
  process.exit(1);
}

function resolveStateFile() {
  if (process.env.KINS_SIDECAR_DIR) {
    const sidecarState = path.join(process.env.KINS_SIDECAR_DIR, "state", "state.json");
    if (fs.existsSync(sidecarState)) {
      return sidecarState;
    }
  }

  const cwdState = path.resolve(".ai", "state.json");
  if (fs.existsSync(cwdState)) {
    return cwdState;
  }

  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (repoRoot) {
      const rootState = path.join(repoRoot, ".ai", "state.json");
      if (fs.existsSync(rootState)) {
        return rootState;
      }
    }
  } catch {
    // Ignore git rev-parse failure
  }

  return cwdState;
}

const statePath = resolveStateFile();
if (!fs.existsSync(statePath)) {
  fail(".ai/state.json not found. Run must be initialized before commit.");
}

let state;
try {
  const content = fs.readFileSync(statePath, "utf-8");
  state = JSON.parse(content);
} catch (err) {
  fail(`Failed to parse .ai/state.json: ${err instanceof Error ? err.message : String(err)}`);
}

// 1. Audit status check
if (!state.audit || state.audit.status !== "closed") {
  fail(
    `Stage 4 Adversarial Audit status must be 'closed' (current: '${state.audit?.status ?? "none"}'). ` +
    `Invoke audit_and_break_code_with_gpt before committing.`
  );
}

// 2. Architectural Compliance check
if (!state.architecturalCompliance) {
  fail("Architectural compliance evidence is missing in .ai/state.json.");
}
if (state.architecturalCompliance.passed !== true) {
  fail(`Architectural compliance check failed (AQI: ${state.architecturalCompliance.aqi ?? "unknown"}).`);
}
const aqi = typeof state.architecturalCompliance.aqi === "number"
  ? state.architecturalCompliance.aqi
  : Number(state.architecturalCompliance.aqi);

if (typeof state.architecturalCompliance.aqi !== "number" || !Number.isFinite(aqi) || aqi < 4.5) {
  fail(`AQI score ${state.architecturalCompliance.aqi} is invalid or below the required threshold of 4.5.`);
}

// 3. Phase check
const validPhases = ["RELEASE_GATE", "COMPLETE"];
if (!validPhases.includes(state.currentPhase) && state.status !== "succeeded") {
  fail(
    `Loop phase must be RELEASE_GATE or COMPLETE before commit (current: '${state.currentPhase}', status: '${state.status}').`
  );
}

// 4. Human Release Sign-off check
const hasReleaseApproval = Boolean(
  state.releaseApproval ||
  state.humanApprovals?.release ||
  state.blueprintApproval
);
if (!hasReleaseApproval) {
  fail("Human release sign-off (RELEASE_SIGN_OFF) is required before commit.");
}

fs.writeSync(1, "[PRE-COMMIT HOOK PASSED]: Stage 4 Audit closed, AQI verified, release ready.\n");
process.exit(0);
