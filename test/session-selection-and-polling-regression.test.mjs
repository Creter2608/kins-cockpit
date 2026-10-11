import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vm from "node:vm";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import {
  TranscriptIngestionService,
  isSubagentDirectoryName
} from "../dist/src/main/services/TranscriptIngestionService.js";
import { TelemetryService } from "../dist/src/main/services/TelemetryService.js";
import { McpMonitorService } from "../dist/src/main/services/McpMonitorService.js";
import { LoopStateService } from "../dist/src/main/services/LoopStateService.js";
import { SubagentService } from "../dist/src/main/services/SubagentService.js";

async function createFixture() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-selection-test-"));
  const homeDir = path.join(tmpDir, "home");
  const projectDir = path.join(tmpDir, "workspace", "my-cockpit-project");
  await fs.mkdir(projectDir, { recursive: true });

  const brainDir = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
  await fs.mkdir(brainDir, { recursive: true });

  return {
    tmpDir,
    homeDir,
    projectDir,
    brainDir,
    async cleanup() {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  };
}

test("REG-01: primary A is replaced by newer same-project primary B", async () => {
  const { tmpDir, homeDir, projectDir, brainDir, cleanup } = await createFixture();
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    process.env.USERPROFILE = homeDir;
    process.env.HOME = homeDir;

    const convADir = path.join(brainDir, "conv-primary-a", ".system_generated", "logs");
    const convBDir = path.join(brainDir, "conv-primary-b", ".system_generated", "logs");
    await fs.mkdir(convADir, { recursive: true });
    await fs.mkdir(convBDir, { recursive: true });

    const logA = path.join(convADir, "transcript.jsonl");
    const logB = path.join(convBDir, "transcript.jsonl");

    await fs.writeFile(
      logA,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        content: `Active Workspaces:\n- ${projectDir}`
      }) + "\n",
      "utf-8"
    );

    await fs.writeFile(
      logB,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        content: `Active Workspaces:\n- ${projectDir}`
      }) + "\n",
      "utf-8"
    );

    const t0 = new Date("2026-10-11T10:00:00Z");
    const t1 = new Date("2026-10-11T11:00:00Z");
    syncFs.utimesSync(logA, t0, t0);
    syncFs.utimesSync(logB, t1, t1);

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const stateFile = path.join(tmpDir, "state.json");
    const loop = new LoopStateService(stateFile);
    const subagents = new SubagentService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, loop, null, subagents);
    await ingestion.setProjectRoot(projectDir);

    // Initial resolution selects newest primary B
    const selected1 = ingestion.findActiveTranscriptPath();
    assert.equal(selected1, logB, "Should select newer primary B initially");

    // Ingest file B once
    ingestion.processFile();

    // Now primary A gets updated to be newer than B
    const t2 = new Date("2026-10-11T12:00:00Z");
    syncFs.utimesSync(logA, t2, t2);

    // Resolution must discover updated primary A
    const selected2 = ingestion.findActiveTranscriptPath();
    assert.equal(selected2, logA, "Must switch to newer primary A when active");
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    await cleanup();
  }
});

test("REG-02: primary A is NOT hijacked by newer subagent B or directory containing -sub-", async () => {
  const { tmpDir, homeDir, projectDir, brainDir, cleanup } = await createFixture();
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    process.env.USERPROFILE = homeDir;
    process.env.HOME = homeDir;

    const convADir = path.join(brainDir, "conv-primary-a", ".system_generated", "logs");
    const convSubDir = path.join(brainDir, "conv-sub-worker", ".system_generated", "logs");
    await fs.mkdir(convADir, { recursive: true });
    await fs.mkdir(convSubDir, { recursive: true });

    const logA = path.join(convADir, "transcript.jsonl");
    const logSub = path.join(convSubDir, "transcript.jsonl");

    await fs.writeFile(
      logA,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        content: `Active Workspaces:\n- ${projectDir}`
      }) + "\n",
      "utf-8"
    );

    await fs.writeFile(
      logSub,
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        content: `Active Workspaces:\n- ${projectDir}`
      }) + "\n",
      "utf-8"
    );

    const t0 = new Date("2026-10-11T10:00:00Z");
    const t1 = new Date("2026-10-11T11:00:00Z");
    syncFs.utimesSync(logA, t0, t0);
    syncFs.utimesSync(logSub, t1, t1); // subagent has newer timestamp

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp);
    await ingestion.setProjectRoot(projectDir);

    const selected = ingestion.findActiveTranscriptPath();
    assert.equal(selected, logA, "Subagent containing '-sub-' must be excluded even if newer");
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    await cleanup();
  }
});

test("REG-03: valid custom path retains absolute precedence over discovered transcripts", async () => {
  const { tmpDir, homeDir, projectDir, brainDir, cleanup } = await createFixture();
  const origProfile = process.env.USERPROFILE;
  const origHome = process.env.HOME;

  try {
    process.env.USERPROFILE = homeDir;
    process.env.HOME = homeDir;

    const customLog = path.join(tmpDir, "custom.jsonl");
    await fs.writeFile(customLog, "{}\n", "utf-8");

    const convDir = path.join(brainDir, "conv-auto", ".system_generated", "logs");
    await fs.mkdir(convDir, { recursive: true });
    const autoLog = path.join(convDir, "transcript.jsonl");
    await fs.writeFile(autoLog, `{"content":"Active Workspaces: ${projectDir}"}\n`, "utf-8");

    const telemetry = new TelemetryService();
    const mcp = new McpMonitorService();
    const ingestion = new TranscriptIngestionService(telemetry, mcp, null, customLog);
    await ingestion.setProjectRoot(projectDir);

    const selected = ingestion.findActiveTranscriptPath();
    assert.equal(selected, customLog, "Custom transcript path must always take precedence");
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.HOME = origHome;
    await cleanup();
  }
});

test("REG-04: isSubagentDirectoryName correctly identifies subagent patterns and known IDs", () => {
  const known = new Set(["custom-subagent-uuid-123"]);

  assert.equal(isSubagentDirectoryName("custom-subagent-uuid-123", known), true);
  assert.equal(isSubagentDirectoryName("conv-sub-b"), true);
  assert.equal(isSubagentDirectoryName("worker_subagent_1"), true);
  assert.equal(isSubagentDirectoryName("task.sub.test"), true);

  // Normal primary session UUIDs must not be flagged
  assert.equal(isSubagentDirectoryName("bb51be1e-4ef5-4ccc-b543-cd5f90a93ce2"), false);
  assert.equal(isSubagentDirectoryName("91106384-ab53-4395-ab54-624df89d0092"), false);
  assert.equal(isSubagentDirectoryName("conv-main-a"), false);
});

function extractFallbackPollCallback() {
  const filename = path.join(process.cwd(), "src/renderer/App.tsx");
  const source = syncFs.readFileSync(filename, "utf8");
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  let callback;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "fallbackPollTimer" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      callback = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  assert.ok(callback, "Existing fallback polling callback must be discoverable");

  return ts.transpileModule(
    `const extractedPoll = ${callback.getText(parsed)};\nextractedPoll();`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS
      }
    }
  ).outputText;
}

test("AUD-01: polling prefers all four lexical setters over environment setters", async () => {
  const lexicalCalls = [];
  const environmentCalls = [];

  const snapshots = {
    telemetry: { auditChannel: "telemetry" },
    loop: { auditChannel: "loop" },
    mcp: { auditChannel: "mcp" },
    subagents: []
  };

  function channel(snapshot) {
    return new Proxy({}, {
      get() {
        return () => Promise.resolve(snapshot);
      }
    });
  }

  const bridge = {
    telemetry: channel(snapshots.telemetry),
    loop: channel(snapshots.loop),
    mcp: channel(snapshots.mcp),
    subagents: channel(snapshots.subagents)
  };

  const names = [
    ["setTelemetry", "telemetry"],
    ["setLoopState", "loop"],
    ["setMcpState", "mcp"],
    ["setSubagents", "subagents"]
  ];

  const env = { clearInterval() {} };
  const context = {
    hostEnv: env,
    pollApi: bridge,
    window: env
  };

  for (const [setter, name] of names) {
    context[setter] = value => lexicalCalls.push([name, value]);
    env[setter] = value => environmentCalls.push([name, value]);
  }

  vm.runInNewContext(extractFallbackPollCallback(), context);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(
    environmentCalls,
    [],
    "Environment setters must not supersede available React setters"
  );

  for (const [, name] of names) {
    const calls = lexicalCalls.filter(([channelName]) => channelName === name);
    assert.equal(calls.length, 1, `${name} lexical setter must run exactly once`);
    assert.strictEqual(calls[0][1], snapshots[name]);
  }
});

test("AUD-02: candidate leaves the AQI harness unchanged from task baseline", () => {
  const repository = execFileSync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { encoding: "utf8", timeout: 180000 }
  ).trim();

  assert.doesNotThrow(() => {
    execFileSync(
      "git",
      ["diff", "--exit-code", "HEAD", "--", "scripts/harness/aqi.mjs"],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 180000,
        stdio: "pipe"
      }
    );
  }, "AQI scorer modifications are forbidden for this task");
});
