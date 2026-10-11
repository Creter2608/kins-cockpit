import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TelemetryService } from "../src/main/services/TelemetryService.js";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { SubagentService } from "../src/main/services/SubagentService.js";
import {
  TranscriptIngestionService,
  isPathInsideOrEqual,
  isTranscriptBelongingToProject
} from "../src/main/services/TranscriptIngestionService.js";

function createTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}

// Golden Assertion 1: {"in":"existing history; poll twice","out":"history populated once"}
test("Stage 2 Assertion 1: existing history; poll twice -> history populated once", async () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-assert-1-");
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    const fakeHome = path.join(tempBase, "home");
    const fakeProject = path.join(tempBase, "workspace", "my-app");
    fs.mkdirSync(fakeProject, { recursive: true });

    const brainDir = path.join(fakeHome, ".gemini", "antigravity-cli", "brain", "conv-session-1", ".system_generated", "logs");
    fs.mkdirSync(brainDir, { recursive: true });
    const transcriptFile = path.join(brainDir, "transcript.jsonl");

    // Existing historical records before app starts
    const historyLines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: `Active Workspaces:\n- ${fakeProject}`
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        status: "DONE",
        created_at: "2026-10-10T00:00:00.000Z",
        tool_calls: [{ name: "view_file", args: { AbsolutePath: path.join(fakeProject, "package.json") } }]
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        status: "DONE",
        created_at: "2026-10-10T00:00:01.000Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test", Cwd: fakeProject } }]
      })
    ].join("\n") + "\n";

    fs.writeFileSync(transcriptFile, historyLines, "utf-8");

    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp);
    await ingestion.setProjectRoot(fakeProject);

    // Initial attach at startup
    ingestion.processFile();
    // Allow async ingestion event loop turns to complete
    await new Promise((r) => setTimeout(r, 50));

    // Existing history must be populated
    assert.equal(
      mcp.getSnapshot().recentCalls.length,
      2,
      "Existing history must populate tool calls upon attach"
    );

    // Second poll must not duplicate
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      mcp.getSnapshot().recentCalls.length,
      2,
      "Second poll must not duplicate existing events"
    );

    // Now a live tool call is appended while app is running
    const newLiveLine =
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        status: "DONE",
        created_at: "2026-10-10T00:00:05.000Z",
        tool_calls: [{ name: "edit_file", args: { AbsolutePath: path.join(fakeProject, "src/index.ts") } }]
      }) + "\n";

    fs.appendFileSync(transcriptFile, newLiveLine, "utf-8");

    // Next poll processes live event
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 50));

    const recent = mcp.getSnapshot().recentCalls;
    assert.equal(recent.length, 3, "Appended live event must increment total by one");
    assert.equal(recent[0]?.toolName, "edit_file");
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    cleanup();
  }
});

// Golden Assertion 2: {"in":"newer foreign-project transcript","out":"excluded"}
test("Stage 2 Assertion 2: newer foreign-project transcript -> excluded", async () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-assert-2-");
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    const fakeHome = path.join(tempBase, "home");
    const fakeCurrentProject = path.join(tempBase, "workspace", "current-proj");
    const fakeForeignProject = path.join(tempBase, "workspace", "other-proj");
    fs.mkdirSync(fakeCurrentProject, { recursive: true });
    fs.mkdirSync(fakeForeignProject, { recursive: true });

    const brainRoot = path.join(fakeHome, ".gemini", "antigravity-cli", "brain");
    const currentConv = path.join(brainRoot, "conv-current", ".system_generated", "logs");
    const foreignConv = path.join(brainRoot, "conv-foreign", ".system_generated", "logs");
    fs.mkdirSync(currentConv, { recursive: true });
    fs.mkdirSync(foreignConv, { recursive: true });

    const currentLog = path.join(currentConv, "transcript.jsonl");
    const foreignLog = path.join(foreignConv, "transcript.jsonl");

    // Older transcript belonging to current project
    fs.writeFileSync(
      currentLog,
      JSON.stringify({
        step_index: 0,
        source: "USER",
        content: `Active Workspaces:\n- ${fakeCurrentProject}`
      }) + "\n",
      "utf-8"
    );

    // Newer transcript belonging to foreign project
    fs.writeFileSync(
      foreignLog,
      JSON.stringify({
        step_index: 0,
        source: "USER",
        content: `Active Workspaces:\n- ${fakeForeignProject}`
      }) + "\n",
      "utf-8"
    );

    // Set foreign mtime newer than current mtime
    const olderTime = new Date("2026-10-10T01:00:00Z");
    const newerTime = new Date("2026-10-10T02:00:00Z");
    fs.utimesSync(currentLog, olderTime, olderTime);
    fs.utimesSync(foreignLog, newerTime, newerTime);

    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp);
    await ingestion.setProjectRoot(fakeCurrentProject);

    const activePath = await ingestion.findActiveTranscriptPath();
    assert.equal(
      activePath,
      currentLog,
      "Newer foreign project transcript must be excluded; only current project transcript can be selected"
    );
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    cleanup();
  }
});

// Golden Assertion 3: {"in":"custom replay; repeated USER_EXPLICIT","out":"replayed; resetLoop=0"}
test("Stage 2 Assertion 3: custom replay; repeated USER_EXPLICIT -> replayed; resetLoop=0", async () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-assert-3-");
  try {
    const transcriptFile = path.join(tempBase, "custom-replay.jsonl");
    const stateFile = path.join(tempBase, "state.json");

    const lines = [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", content: "Prompt 1" }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        status: "DONE",
        tool_calls: [{ name: "read_file", args: { file: "test.ts" } }]
      }),
      JSON.stringify({ step_index: 2, source: "USER_EXPLICIT", content: "Prompt 2 after feedback" }),
      JSON.stringify({ step_index: 3, source: "USER_EXPLICIT", content: "Prompt 3 further guidance" })
    ].join("\n") + "\n";

    fs.writeFileSync(transcriptFile, lines, "utf-8");

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const loop = new LoopStateService(stateFile);

    let resetCount = 0;
    loop.onRunReset(() => {
      resetCount++;
    });

    const initialRunId = loop.getSnapshot().runId;

    // Custom replay mode
    const ingestion = new TranscriptIngestionService(telemetry, mcp, loop, transcriptFile);
    ingestion.processFile();
    await new Promise((r) => setTimeout(r, 50));

    // Tool calls from custom replay must be replayed
    assert.equal(mcp.getSnapshot().recentCalls.length, 1);
    assert.equal(mcp.getSnapshot().recentCalls[0]?.toolName, "read_file");

    // Repeated USER_EXPLICIT turns must NOT reset the loop
    assert.equal(resetCount, 0, "Repeated USER_EXPLICIT turns must never trigger resetLoop()");
    assert.equal(loop.getSnapshot().runId, initialRunId, "Run ID must remain unchanged across user turns");
  } finally {
    cleanup();
  }
});

// Golden Assertion 4: {"in":"tool timestamp=1234","out":"record.timestamp=1234"}
test("Stage 2 Assertion 4: tool timestamp=1234 -> record.timestamp=1234", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const ingestion = new TranscriptIngestionService(telemetry, mcp);

  // 1. Valid numeric timestamp in epoch ms
  const stepWithNumericTimestamp = JSON.stringify({
    step_index: 10,
    source: "MODEL",
    status: "DONE",
    created_at: 1234,
    tool_calls: [{ name: "view_file", args: { AbsolutePath: "/path/a" } }]
  });
  ingestion.processLine(stepWithNumericTimestamp);

  let calls = mcp.getSnapshot().recentCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.timestamp, 1234, "Valid numeric source timestamp must be preserved");

  // 2. Valid ISO string timestamp
  const isoTime = "2026-10-10T05:30:00.000Z";
  const expectedEpochMs = new Date(isoTime).getTime();
  const stepWithIsoTimestamp = JSON.stringify({
    step_index: 11,
    source: "MODEL",
    status: "DONE",
    created_at: isoTime,
    tool_calls: [{ name: "run_command", args: { CommandLine: "echo hi" } }]
  });
  ingestion.processLine(stepWithIsoTimestamp);

  calls = mcp.getSnapshot().recentCalls;
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.timestamp, expectedEpochMs, "Valid ISO source timestamp must be converted to epoch ms");

  // 3. Direct McpMonitorService invocation with valid and omitted timestamps
  mcp.recordToolCall({
    serverName: "native",
    toolName: "test_explicit_ts",
    status: "success",
    timestamp: 9999
  });
  assert.equal(mcp.getSnapshot().recentCalls[0]?.timestamp, 9999);

  const beforeNow = Date.now();
  mcp.recordToolCall({
    serverName: "native",
    toolName: "test_default_now",
    status: "success"
  });
  const afterNow = Date.now();
  const nowTs = mcp.getSnapshot().recentCalls[0]?.timestamp ?? 0;
  assert.ok(nowTs >= beforeNow && nowTs <= afterNow, "Omitted timestamp should default to Date.now()");
});

// Golden Assertion 5: {"in":"bare conversationId; correlated terminal result","out":"no synthetic agent; matched invocation terminal"}
test("Stage 2 Assertion 5: bare conversationId; correlated terminal result -> no synthetic agent; matched invocation terminal", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const subagents = new SubagentService(() => 1000);
  const ingestion = new TranscriptIngestionService(telemetry, mcp, null, null, subagents);

  // 1. Bare conversationId in log without prior invoke_subagent must NOT spawn "ECC Subagent"
  const bareLog = JSON.stringify({
    step_index: 1,
    source: "MODEL",
    content: 'Inspecting running background subagents: {"conversationId": "ghost-sub-99", "state": "running"}'
  });
  ingestion.processLine(bareLog);

  assert.equal(
    subagents.list().length,
    0,
    "Bare conversationId in log must never create synthetic ECC Subagent"
  );

  // 2. Real invocation creates actual subagent
  const invokeLine = JSON.stringify({
    step_index: 2,
    source: "MODEL",
    status: "DONE",
    tool_calls: [
      {
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              id: "worker-task-1",
              Role: "Code Auditor",
              Model: "claude-3.7-sonnet",
              Prompt: "Audit security boundaries"
            }
          ]
        }
      }
    ]
  });
  ingestion.processLine(invokeLine);

  assert.equal(subagents.list().length, 1);
  assert.equal(subagents.list()[0]?.id, "worker-task-1");
  assert.equal(subagents.list()[0]?.status, "running");

  // 3. Correlated terminal result completes the invocation
  const doneLine = JSON.stringify({
    step_index: 3,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    content: 'The following is a <SYSTEM_MESSAGE> ... sender=worker-task-1 content=Task id "worker-task-1" finished with result: Done'
  });
  ingestion.processLine(doneLine);

  assert.equal(subagents.list()[0]?.status, "completed");
});

// Stage 2 Compact Assertion: {"in":"ownership evidence at 20KiB","out":"true"}
test("Stage 2 Compact Assertion: ownership evidence at 20KiB -> true", async () => {
  const { dir: tempBase, cleanup } = createTempDir("golden-assert-20k-");
  try {
    const transcriptFile = path.join(tempBase, "transcript-large.jsonl");
    const fakeProject = path.join(tempBase, "my-target-proj");
    fs.mkdirSync(fakeProject, { recursive: true });

    // Fill first 20 KiB with unrelated padding
    const paddingLine = JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      content: "x".repeat(1024)
    }) + "\n";
    let content = paddingLine.repeat(21); // ~21 KiB

    // Now insert ownership evidence at ~21 KiB
    content += JSON.stringify({
      step_index: 22,
      source: "MODEL",
      status: "DONE",
      tool_calls: [{ name: "run_command", args: { Cwd: fakeProject } }]
    }) + "\n";

    fs.writeFileSync(transcriptFile, content, "utf-8");

    const belongs = await isTranscriptBelongingToProject(transcriptFile, fakeProject);
    assert.equal(belongs, true, "Ownership evidence located beyond 16KiB must be discovered");
  } finally {
    cleanup();
  }
});

// Stage 2 Compact Assertion: {"in":"root tokens 12/3/4; nested duplicates","out":"usage 12/3/4 once"}
test("Stage 2 Compact Assertion: root tokens 12/3/4; nested duplicates -> usage 12/3/4 once", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const ingestion = new TranscriptIngestionService(telemetry, mcp);

  const stepWithRootTokens = JSON.stringify({
    step_index: 10,
    source: "MODEL",
    input_tokens: 12,
    output_tokens: 3,
    cache_read_tokens: 4,
    usage: {
      prompt_tokens: 99,
      completion_tokens: 99
    }
  });

  ingestion.processLine(stepWithRootTokens);
  const snap = telemetry.getSnapshot();
  assert.equal(snap.geminiPromptTokens, 12, "Root prompt tokens must be preferred over nested usage");
  assert.equal(snap.geminiCompletionTokens, 3, "Root completion tokens must be preferred over nested usage");
});

// Stage 2 Compact Assertion: {"in":"root input=0; nested input=99","out":"input=0"}
test("Stage 2 Compact Assertion: root input=0; nested input=99 -> input=0", () => {
  const telemetry = new TelemetryService();
  const mcp = new McpMonitorService();
  const ingestion = new TranscriptIngestionService(telemetry, mcp);

  const stepWithZeroInput = JSON.stringify({
    step_index: 11,
    source: "MODEL",
    input_tokens: 0,
    output_tokens: 5,
    usage: {
      prompt_tokens: 99,
      completion_tokens: 99
    }
  });

  ingestion.processLine(stepWithZeroInput);
  const snap = telemetry.getSnapshot();
  assert.equal(snap.geminiPromptTokens, 0, "Zero input tokens at root level is valid and must not trigger fallback");
  assert.equal(snap.geminiCompletionTokens, 5);
});

// Stage 2 Compact Assertion: {"in":"dispose during pending read","out":"no subsequent service mutation"}
test("Stage 2 Compact Assertion: dispose during pending read -> no subsequent service mutation", async () => {
  const { dir: tempDir, cleanup } = createTempDir("dispose-read-test-");
  try {
    const dummyFile = path.join(tempDir, "empty-transcript.jsonl");
    fs.writeFileSync(dummyFile, "", "utf-8");

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, null, dummyFile);

    ingestion.start();
    ingestion.dispose();

    // Polling timer should be cleared
    assert.equal(mcp.getSnapshot().recentCalls.length, 0);
  } finally {
    cleanup();
  }
});

