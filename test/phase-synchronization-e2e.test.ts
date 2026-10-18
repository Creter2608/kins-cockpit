import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";

function createTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
}

test("E2E Phase Sync & Reset: Previous loop in COMPLETE automatically resets when new cycle starts", async () => {
  const { dir: tempBase, cleanup } = createTempDir("phase-sync-e2e-");
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    const fakeHome = path.join(tempBase, "home");
    const fakeProject = path.join(tempBase, "workspace", "my-app");
    fs.mkdirSync(fakeProject, { recursive: true });

    const brainDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", "conv-session-sync", ".system_generated", "logs");
    fs.mkdirSync(brainDir, { recursive: true });
    const transcriptFile = path.join(brainDir, "transcript.jsonl");

    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;

    const stateFile = path.join(tempBase, "loop-state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-initial-old",
        currentPhase: "COMPLETE",
        status: "succeeded",
        usage: { transitions: 9, retries: 0, operations: 15 },
        budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
        history: [{ from: "RELEASE_GATE", to: "COMPLETE", at: "2026-10-18T10:00:00.000Z" }]
      }),
      "utf-8"
    );

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const loopService = new LoopStateService(stateFile);
    const ingestion = new TranscriptIngestionService(telemetry, mcp, loopService, transcriptFile);
    await ingestion.setProjectRoot(fakeProject);

    // Initial state check: loop is at COMPLETE
    const oldSnap = loopService.getSnapshot();
    assert.equal(oldSnap.currentPhase, "COMPLETE");
    assert.equal(oldSnap.status, "succeeded");
    const oldRunId = oldSnap.runId;

    // Simulate new user turn with explicit [Phase: INITIALIZE]
    const newSessionLine = JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      content: `Active Workspaces:\n- ${fakeProject}\nBắt đầu loop mới để kiểm tra tính năng phase tracker.`
    }) + "\n";

    fs.appendFileSync(transcriptFile, newSessionLine, "utf-8");

    // Ingest the new step
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 80));

    // Verification 1: Loop MUST have reset
    const newSnap = loopService.getSnapshot();
    assert.notEqual(newSnap.runId, oldRunId, "runId must be updated on new loop cycle");
    assert.equal(newSnap.currentPhase, "INITIALIZE", "Phase must be reset to INITIALIZE");
    assert.equal(newSnap.status, "ready", "Status must be ready after reset");

    // Simulate Model step advancing to SPEC_GATE
    const modelStep1 = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "[Phase: SPEC_GATE]\n📋 [Template Applied]: Loaded spec-document-reviewer-prompt.md"
    }) + "\n";

    fs.appendFileSync(transcriptFile, modelStep1, "utf-8");
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 80));

    const specSnap = loopService.getSnapshot();
    assert.equal(specSnap.currentPhase, "SPEC_GATE", "Phase must advance to SPEC_GATE");

    // Simulate Model step attempting to jump directly to COMPLETE without blueprintApproval
    const unapprovedCompleteStep = JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      content: "Xin chào bạn, tôi sẽ hoàn thành công việc này!\n[Phase: COMPLETE]"
    }) + "\n";

    fs.appendFileSync(transcriptFile, unapprovedCompleteStep, "utf-8");
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 80));

    // Verification 2: Traversal must be stopped before EXECUTE/COMPLETE because PLAN -> EXECUTE has no blueprint
    const blockedSnap = loopService.getSnapshot();
    assert.notEqual(blockedSnap.currentPhase, "COMPLETE", "Bypass directly to COMPLETE must be strictly blocked");
    assert.equal(blockedSnap.currentPhase, "PLAN", "Loop must be stopped at PLAN due to Guard 1 (missing blueprintApproval)");

  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    cleanup();
  }
});
