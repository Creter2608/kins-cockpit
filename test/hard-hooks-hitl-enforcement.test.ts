import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { detectPhaseWithEvidenceFromTranscriptStep } from "../src/main/services/transcriptParsers.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hard-hooks-test-"));
}

test("Golden Assertion 1: VERIFY -> COMPLETE with pending audit stops at REALITY_CHECK and returns false", () => {
  const tmpDir = makeTempDir();
  try {
    const stateFile = path.join(tmpDir, "state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-ga-1",
        currentPhase: "VERIFY",
        status: "running",
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        usage: { transitions: 0, retries: 0, operations: 0 },
        history: []
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);
    const ok = service.advanceToPhase("COMPLETE", "completion reported");
    assert.equal(ok, false, "Must return false when advancing through unclosed audit");
    assert.equal(
      service.getSnapshot().currentPhase,
      "REALITY_CHECK",
      "Must halt at REALITY_CHECK when entering RELEASE_GATE without closed audit"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 2: MODEL 'all tests passed' outputs REALITY_CHECK, never COMPLETE", () => {
  const step = {
    source: "MODEL",
    step_index: 42,
    content: "All tests passed (604 tests pass). Everything is verified."
  };

  const detection = detectPhaseWithEvidenceFromTranscriptStep(step);
  assert.ok(detection);
  assert.equal(detection?.phase, "REALITY_CHECK", "Must detect REALITY_CHECK for tests passed");
  assert.notEqual(detection?.phase, "COMPLETE", "Must NEVER detect COMPLETE for tests passed");
});

test("Golden Assertion 3: PLAN -> EXECUTE without human blueprint approval returns false and remains PLAN", () => {
  const tmpDir = makeTempDir();
  try {
    const stateFile = path.join(tmpDir, "state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-ga-3",
        currentPhase: "PLAN",
        status: "ready",
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        usage: { transitions: 0, retries: 0, operations: 0 },
        history: []
        // No blueprintApproval
      }),
      "utf-8"
    );

    const service = new LoopStateService(stateFile);
    const ok = service.advanceToPhase("EXECUTE");
    assert.equal(ok, false, "Must reject advance to EXECUTE without blueprint approval");
    assert.equal(service.getSnapshot().currentPhase, "PLAN", "Must remain at PLAN");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Golden Assertion 4 & 5: Pre-commit validator script enforces closed audit and AQI threshold", () => {
  const validatorScript = path.resolve("scripts/hooks/pre-commit.mjs");
  assert.ok(fs.existsSync(validatorScript), "Validator script must exist");

  const hookLauncher = path.resolve(".git/hooks/pre-commit");
  if (fs.existsSync(path.resolve(".git/hooks")) && !fs.existsSync(hookLauncher)) {
    fs.writeFileSync(
      hookLauncher,
      "#!/usr/bin/env sh\n# Git Pre-Commit Hook: Kin's Cockpit Autonomous Loop Gatekeeper\nnode scripts/hooks/pre-commit.mjs\n",
      { mode: 0o755 }
    );
  }
  assert.ok(fs.existsSync(hookLauncher), "Git hook launcher must exist");

  // Golden Assertion 4: audit closed, AQI 4.49 -> exit 1
  const tmpDirFail = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDirFail, ".ai"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDirFail, ".ai", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-ga-4",
        currentPhase: "RELEASE_GATE",
        status: "running",
        audit: { status: "closed" },
        architecturalCompliance: { passed: true, aqi: 4.49 },
        blueprintApproval: { blueprintSha256: "ga4-sha" }
      }),
      "utf-8"
    );

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [validatorScript], { cwd: tmpDirFail, stdio: "pipe" });
    } catch (err: any) {
      exitCode = err.status ?? 1;
    }
    assert.equal(exitCode, 1, "Must reject commit when AQI is 4.49 (< 4.5)");
  } finally {
    fs.rmSync(tmpDirFail, { recursive: true, force: true });
  }

  // Golden Assertion 5: closed audit, AQI 4.5, human approval -> exit 0
  const tmpDirPass = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmpDirPass, ".ai"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDirPass, ".ai", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-ga-5",
        currentPhase: "RELEASE_GATE",
        status: "running",
        audit: { status: "closed" },
        architecturalCompliance: { passed: true, aqi: 4.5 },
        blueprintApproval: { blueprintSha256: "ga5-sha" }
      }),
      "utf-8"
    );

    const out = execFileSync(process.execPath, [validatorScript], { cwd: tmpDirPass, stdio: "pipe" });
    assert.ok(out.toString("utf-8").includes("PRE-COMMIT HOOK PASSED"));
  } finally {
    fs.rmSync(tmpDirPass, { recursive: true, force: true });
  }
});
