import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { SubagentService } from "../src/main/services/SubagentService.js";
import { TranscriptIngestionService } from "../src/main/services/TranscriptIngestionService.js";

function createTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  };
}

// Golden Assertion 1: {"in":"Pinned main A; subagent B gets newer mtime","out":"Still A"}
test("Stage 1 Golden Assertion 1: Pinned main A; subagent B gets newer mtime -> Still A", async () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-1-pinned-");
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    const fakeHome = path.join(tempBase, "home");
    const fakeProject = path.join(tempBase, "workspace", "my-project");
    fs.mkdirSync(fakeProject, { recursive: true });

    const brainDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain");
    const mainLogDir = path.join(brainDir, "conv-main-a", ".system_generated", "logs");
    const subLogDir = path.join(brainDir, "conv-sub-b", ".system_generated", "logs");
    fs.mkdirSync(mainLogDir, { recursive: true });
    fs.mkdirSync(subLogDir, { recursive: true });

    const mainLog = path.join(mainLogDir, "transcript.jsonl");
    const subLog = path.join(subLogDir, "transcript.jsonl");

    fs.writeFileSync(
      mainLog,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        content: `Active Workspaces:\n- ${fakeProject}`
      }) + "\n",
      "utf-8"
    );

    fs.writeFileSync(
      subLog,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        content: `Active Workspaces:\n- ${fakeProject}`
      }) + "\n",
      "utf-8"
    );

    // Initial state: mainLog has newer mtime than subLog
    const t0 = new Date("2026-10-10T01:00:00Z");
    const t1 = new Date("2026-10-10T02:00:00Z");
    fs.utimesSync(subLog, t0, t0);
    fs.utimesSync(mainLog, t1, t1);

    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp);
    await ingestion.setProjectRoot(fakeProject);

    // Initial resolution selects mainLog A
    const selectedA = await ingestion.findActiveTranscriptPath();
    assert.equal(selectedA, mainLog);

    // Pin session by processing file once
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 40));

    // Now subagent B writes new activity and gets a MUCH newer mtime
    const t2 = new Date("2026-10-10T05:00:00Z");
    fs.appendFileSync(
      subLog,
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        content: "Subagent B working"
      }) + "\n",
      "utf-8"
    );
    fs.utimesSync(subLog, t2, t2);

    // Subsequent resolution MUST remain pinned to mainLog A!
    const selectedAfterB = await ingestion.findActiveTranscriptPath();
    assert.equal(selectedAfterB, mainLog, "Pinned main A must not be hijacked by newer subagent B");
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    cleanup();
  }
});

// Golden Assertion 2: {"in":"Subagent phase text + 900 completion tokens","out":"Phase and main usage unchanged"}
test("Stage 1 Golden Assertion 2: Subagent phase text + 900 completion tokens -> Phase and main usage unchanged", () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-2-phase-");
  try {
    const stateFile = path.join(tempBase, "state.json");
    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const loop = new LoopStateService(stateFile);
    const subagents = new SubagentService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, loop, null, subagents);

    // Baseline: Main agent in PLAN phase with 50 tokens
    loop.advanceToPhase("PLAN", "main planning");
    const mainStep = JSON.stringify({
      step_index: 1,
      source: "MODEL",
      output_tokens: 50,
      content: "Main planning step"
    });
    ingestion.processLine(mainStep);

    const initialPhase = loop.getSnapshot().currentPhase;
    const initialCompTokens = telemetry.getSnapshot().geminiCompletionTokens;
    assert.equal(initialPhase, "PLAN");
    assert.equal(initialCompTokens, 50);

  // Now a subagent step arrives carrying phase text [Phase: VERIFY] and 900 tokens
  const subagentStep = JSON.stringify({
    step_index: 2,
    source: "MODEL",
    is_subagent: true,
    output_tokens: 900,
    content: "[Phase: VERIFY] [Template Applied]: Loaded task-reviewer-prompt.md for subagent review"
  });
  ingestion.processLine(subagentStep);

    // Phase and main telemetry MUST remain completely unchanged!
    assert.equal(
      loop.getSnapshot().currentPhase,
      initialPhase,
      "Subagent step must never advance main agent loop phase"
    );
    assert.equal(
      telemetry.getSnapshot().geminiCompletionTokens,
      initialCompTokens,
      "Subagent tokens must never increment main agent totalGeminiCompletion"
    );
  } finally {
    cleanup();
  }
});

// Golden Assertion 3: {"in":"Truncated 2-agent batch; full record available; replay","out":"Exactly 2 ordered role/model/prompt invocations"}
test("Stage 1 Golden Assertion 3: Truncated 2-agent batch; full record available; replay -> Exactly 2 ordered role/model/prompt invocations", async () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-3-batch-");
  try {
    const transcriptDir = path.join(tempBase, "conv", ".system_generated", "logs");
    fs.mkdirSync(transcriptDir, { recursive: true });

    const transcriptFile = path.join(transcriptDir, "transcript.jsonl");
    const fullTranscriptFile = path.join(transcriptDir, "transcript_full.jsonl");

    // Full untruncated step with 2 subagents
    const fullStep = {
      step_index: 1,
      source: "MODEL",
      status: "DONE",
      created_at: "2026-10-10T00:00:00.000Z",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            Subagents: [
              {
                Role: "ECC Code Architect",
                Model: "gemini-3.8-flash",
                Prompt: "Conduct architectural health check\nPreserve clean separation"
              },
              {
                Role: "ECC Security Reviewer",
                Model: "claude-3.7-sonnet",
                Prompt: "Adversarial security review"
              }
            ]
          }
        }
      ]
    };

    // Compact transcript step with truncated_fields: ["tool_calls"]
    const truncatedStep = {
      step_index: 1,
      source: "MODEL",
      status: "DONE",
      created_at: "2026-10-10T00:00:00.000Z",
      truncated_fields: ["tool_calls"],
      tool_calls: [
        {
          name: "invoke_subagent",
          args: '{"Subagents":[{"Role":"ECC Code Architect","Model":"gemini-3.8-flash","Prompt":"Conduct architectural health check'
        }
      ]
    };

    fs.writeFileSync(transcriptFile, JSON.stringify(truncatedStep) + "\n", "utf-8");
    fs.writeFileSync(fullTranscriptFile, JSON.stringify(fullStep) + "\n", "utf-8");

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const subagents = new SubagentService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, null, transcriptFile, subagents);

    // Ingest first time
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 60));

    let list = subagents.list();
    assert.equal(list.length, 2, "Must recover exactly 2 subagents from full record");
    assert.equal(list[0]?.role, "ECC Security Reviewer"); // newest first
    assert.equal(list[1]?.role, "ECC Code Architect");
    assert.equal(list[1]?.promptSummary, "Conduct architectural health check Preserve clean separation");

    // Replay ingestion: must be idempotent and not duplicate
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 60));

    list = subagents.list();
    assert.equal(list.length, 2, "Replay must remain exactly 2 subagents without duplicates");
  } finally {
    cleanup();
  }
});

// Golden Assertion 4: {"in":"Bound sender: progress; wrong sender: terminal","out":"Neither completes"}
test("Stage 1 Golden Assertion 4: Bound sender: progress; wrong sender: terminal -> Neither completes", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const subagents = new SubagentService(() => 1000);
  const ingestion = new TranscriptIngestionService(telemetry, mcp, null, null, subagents);

  // Register subagent and bind conversation ID
  subagents.recordInvocation({
    id: "sub-1",
    role: "Code Reviewer",
    prompt: "Review code"
  });
  subagents.bindConversationId("sub-1", "conv-bound-1");

  assert.equal(subagents.list()[0]?.status, "running");

  // Case 1: Bound sender emits progress message (not a terminal event)
  const progressLine = JSON.stringify({
    step_index: 2,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    sender: "conv-bound-1",
    content: "The following is a <SYSTEM_MESSAGE> sender=conv-bound-1 content=Scanning files: 50% completed so far, continuing"
  });
  ingestion.processLine(progressLine);
  assert.equal(subagents.list()[0]?.status, "running", "Bound sender progress message must NOT complete subagent");

  // Case 2: Wrong/unbound sender emits terminal message
  const wrongSenderTerminalLine = JSON.stringify({
    step_index: 3,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    sender: "conv-unbound-random",
    content: 'The following is a <SYSTEM_MESSAGE> sender=conv-unbound-random content=Task id "conv-unbound-random" finished with result: Done'
  });
  ingestion.processLine(wrongSenderTerminalLine);
  assert.equal(subagents.list()[0]?.status, "running", "Wrong sender terminal event must NOT complete bound subagent");
});

// Golden Assertion 5: {"in":"Bound sender: genuine terminal event","out":"Only its subagent completes"}
test("Stage 1 Golden Assertion 5: Bound sender: genuine terminal event -> Only its subagent completes", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const subagents = new SubagentService(() => 1000);
  const ingestion = new TranscriptIngestionService(telemetry, mcp, null, null, subagents);

  // Register two subagents and bind conversation IDs
  subagents.recordInvocation({
    id: "sub-1",
    role: "Worker 1",
    prompt: "Task 1"
  });
  subagents.bindConversationId("sub-1", "conv-bound-1");

  subagents.recordInvocation({
    id: "sub-2",
    role: "Worker 2",
    prompt: "Task 2"
  });
  subagents.bindConversationId("sub-2", "conv-bound-2");

  assert.equal(subagents.list().find((s) => s.id === "sub-1")?.status, "running");
  assert.equal(subagents.list().find((s) => s.id === "sub-2")?.status, "running");

  // Bound sender conv-bound-1 emits genuine terminal event
  const terminalLine = JSON.stringify({
    step_index: 5,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    sender: "conv-bound-1",
    content: 'The following is a <SYSTEM_MESSAGE> sender=conv-bound-1 content=Task id "conv-bound-1" finished with result: All checks passed'
  });
  ingestion.processLine(terminalLine);

  // Only sub-1 must complete, sub-2 must still be running
  assert.equal(
    subagents.list().find((s) => s.id === "sub-1")?.status,
    "completed",
    "Subagent 1 with bound matching sender must complete"
  );
  assert.equal(
    subagents.list().find((s) => s.id === "sub-2")?.status,
    "running",
    "Subagent 2 must remain running"
  );
});
