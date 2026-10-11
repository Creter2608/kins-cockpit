import test from "node:test";
import * as assert from "node:assert/strict";
import {
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep,
  parseGptTokenUsageLine,
  extractSubagentInvocations
} from "../src/main/services/transcriptParsers.js";

import {
  isVerificationCommand as legacyIsVerificationCommand,
  isIsolationCommand as legacyIsIsolationCommand,
  isStackDetectionTarget as legacyIsStackDetectionTarget,
  parseVerificationOutput as legacyParseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep as legacyDetectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep as legacyDetectPhaseFromTranscriptStep,
  parseGptTokenUsageLine as legacyParseGptTokenUsageLine
} from "../src/main/services/TranscriptIngestionService.js";

// Assertion 1: {"in":"known verification command","out":"same classification as legacy parser"}
test("transcriptParsers: known verification commands correctly classified", () => {
  const commands = [
    "npm test",
    "npm run typecheck",
    "pytest tests/",
    "cargo test",
    "vitest run"
  ];

  for (const cmd of commands) {
    assert.equal(isVerificationCommand(cmd), true);
    assert.equal(legacyIsVerificationCommand(cmd), true);
  }
});

// Assertion 2: {"in":"near-match command","out":"not broadened into a match"}
test("transcriptParsers: near-match command not falsely classified", () => {
  const falsePositives = [
    "echo testing",
    "git commit -m 'update tests'",
    "npm run build",
    "node server.js"
  ];

  for (const cmd of falsePositives) {
    assert.equal(isVerificationCommand(cmd), false);
    assert.equal(legacyIsVerificationCommand(cmd), false);
  }

  assert.equal(isIsolationCommand("git status"), false);
  assert.equal(isStackDetectionTarget("README.md"), false);
  assert.equal(isStackDetectionTarget("package.json"), true);
});

// Assertion 3: {"in":"known phase transcript step","out":"same phase and evidence object"}
test("transcriptParsers: known phase transcript step produces exact phase and evidence", () => {
  const step = {
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "run_command",
        args: { CommandLine: "npm test" }
      }
    ]
  };

  const res = detectPhaseWithEvidenceFromTranscriptStep(step);
  const legacyRes = legacyDetectPhaseWithEvidenceFromTranscriptStep(step);

  assert.ok(res);
  assert.deepEqual(res, legacyRes);
  assert.equal(res.phase, "VERIFY");
  assert.equal(res.evidence, "cmd: npm test");

  const simplePhase = detectPhaseFromTranscriptStep(step);
  assert.equal(simplePhase, "VERIFY");
  assert.equal(simplePhase, legacyDetectPhaseFromTranscriptStep(step));
});

// Assertion 4: {"in":"valid GPT/Gemini usage lines","out":"exact legacy token objects"}
test("transcriptParsers: valid GPT token usage lines parsed identically to legacy parser", () => {
  const line = "GPT Token Usage: Input: 2,354 (Cached: 1,787) | Output: Blueprint: 2,687 | Thinking: 821 | Total: 5,862";
  const parsed = parseGptTokenUsageLine(line);
  const legacyParsed = legacyParseGptTokenUsageLine(line);

  assert.ok(parsed);
  assert.deepEqual(parsed, legacyParsed);
  assert.equal(parsed.inputTokens, 2354);
  assert.equal(parsed.cachedTokens, 1787);
  assert.equal(parsed.outputTokens, 3508); // 2687 + 821
  assert.equal(parsed.missTokens, 567);
  assert.equal(parsed.totalTokens, 5862);

  // gpt_architect format with Content: and Thinking:
  const gptArchLineWithThinking = "📊 [GPT Token Usage]: Input: 5,218 (Cached: 2,048) | Output: Content: 4,574 | Thinking: 2,916 | Total: 12,708 | Cost: $0.0512 (51200 µUSD)";
  const parsedGptArch = parseGptTokenUsageLine(gptArchLineWithThinking);
  assert.ok(parsedGptArch);
  assert.equal(parsedGptArch.inputTokens, 5218);
  assert.equal(parsedGptArch.cachedTokens, 2048);
  assert.equal(parsedGptArch.outputTokens, 7490); // 4574 + 2916
  assert.equal(parsedGptArch.missTokens, 3170);
  assert.equal(parsedGptArch.totalTokens, 12708);

  // gpt_architect format with Content: only
  const gptArchLineNoThinking = "📊 [GPT Token Usage]: Input: 5,218 (Cached: 2,048) | Output: Content: 1,877 | Total: 7,095 | Cost: $0.0212 (21200 µUSD)";
  const parsedGptArchNoThinking = parseGptTokenUsageLine(gptArchLineNoThinking);
  assert.ok(parsedGptArchNoThinking);
  assert.equal(parsedGptArchNoThinking.inputTokens, 5218);
  assert.equal(parsedGptArchNoThinking.cachedTokens, 2048);
  assert.equal(parsedGptArchNoThinking.outputTokens, 1877);
  assert.equal(parsedGptArchNoThinking.missTokens, 3170);
  assert.equal(parsedGptArchNoThinking.totalTokens, 7095);

  // Invalid usage line
  assert.equal(parseGptTokenUsageLine("No token data here"), null);
});

// Assertion 5: {"in":"legacy service imports","out":"same parser exports and behavior"}
test("transcriptParsers: backward compatibility re-exports from TranscriptIngestionService", () => {
  assert.strictEqual(legacyIsVerificationCommand, isVerificationCommand);
  assert.strictEqual(legacyIsIsolationCommand, isIsolationCommand);
  assert.strictEqual(legacyIsStackDetectionTarget, isStackDetectionTarget);
  assert.strictEqual(legacyParseVerificationOutput, parseVerificationOutput);
  assert.strictEqual(legacyDetectPhaseWithEvidenceFromTranscriptStep, detectPhaseWithEvidenceFromTranscriptStep);
  assert.strictEqual(legacyDetectPhaseFromTranscriptStep, detectPhaseFromTranscriptStep);
  assert.strictEqual(legacyParseGptTokenUsageLine, parseGptTokenUsageLine);

  // Verification output parsing (TAP and Jest formats)
  const tapOutput = "# pass 42\n# fail 0";
  const tapRes = parseVerificationOutput(tapOutput);
  assert.ok(tapRes);
  assert.equal(tapRes.status, "pass");
  assert.equal(tapRes.passCount, 42);
  assert.equal(tapRes.failCount, 0);

  const jestOutput = "Tests: 2 failed, 10 passed";
  const jestRes = parseVerificationOutput(jestOutput);
  assert.ok(jestRes);
  assert.equal(jestRes.status, "fail");
  assert.equal(jestRes.passCount, 10);
  assert.equal(jestRes.failCount, 2);
});

test("transcriptParsers: handles both [Workflow Applied] and [Template Applied] markers", () => {
  const stepTemplate = {
    step_index: 3,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "📋 [Template Applied]: Loaded implementer-prompt.md for feature execution"
  };
  const stepWorkflow = {
    step_index: 4,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "📋 [Workflow Applied]: Loaded implementer-prompt.md for feature execution"
  };

  const resTemplate = detectPhaseFromTranscriptStep(stepTemplate);
  const resWorkflow = detectPhaseFromTranscriptStep(stepWorkflow);

  assert.equal(resTemplate, "EXECUTE");
  assert.equal(resWorkflow, "EXECUTE");
});

test("transcriptParsers: subagent events never drive main loop phase detection", () => {
  // 1. Tool call with invoke_subagent must NOT advance phase
  const invokeStep = {
    step_index: 5,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: [
      {
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              Role: "ECC Security Reviewer",
              Prompt: "[Template Applied]: Loaded task-reviewer-prompt.md"
            }
          ]
        }
      }
    ]
  };
  assert.equal(detectPhaseWithEvidenceFromTranscriptStep(invokeStep), null);

  // 2. Subagent step with phase text must NOT advance phase
  const subagentStep = {
    step_index: 6,
    source: "MODEL",
    is_subagent: true,
    content: "[Phase: VERIFY] [Template Applied]: Loaded task-reviewer-prompt.md"
  };
  assert.equal(detectPhaseWithEvidenceFromTranscriptStep(subagentStep), null);

  // 3. System notification message with sender must NOT advance phase
  const systemStep = {
    step_index: 7,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    content: "<SYSTEM_MESSAGE> [Message] sender=conv-123 content=Done [Phase: COMPLETE]"
  };
  assert.equal(detectPhaseWithEvidenceFromTranscriptStep(systemStep), null);
});

test("transcriptParsers: extractSubagentInvocations parses structured and truncated batches", () => {
  // 1. Clean structured batch with 4 subagents
  const structuredTc = {
    name: "invoke_subagent",
    args: {
      Subagents: [
        { Role: "Architect", Model: "gpt-4", Prompt: "Review architecture\nline 2" },
        { Role: "Security", Model: "sonnet", Prompt: "Audit security" },
        { Role: "Failure Hunter", Prompt: "Hunt silent bugs" },
        { TypeName: "Tester", Prompt: "Run tests" }
      ]
    }
  };
  const extracted = extractSubagentInvocations(structuredTc);
  assert.equal(extracted.length, 4);
  assert.equal(extracted[0]?.role, "Architect");
  assert.equal(extracted[0]?.model, "gpt-4");
  assert.equal(extracted[0]?.prompt, "Review architecture\nline 2");
  assert.equal(extracted[2]?.model, "inherit", "Model should default to inherit");
  assert.equal(extracted[3]?.role, "Tester", "TypeName should be accepted as role alias");

  // 2. Truncated JSON string batch
  const truncatedJsonStr = '{"Subagents": [{"Role": "Agent1", "Model": "m1", "Prompt": "Prompt 1"}, {"Role": "Agent2", "Model": "m2", "Prompt": "Prompt 2';
  const extractedTrunc = extractSubagentInvocations({ name: "invoke_subagent", args: truncatedJsonStr });
  assert.equal(extractedTrunc.length, 2);
  assert.equal(extractedTrunc[0]?.role, "Agent1");
  assert.equal(extractedTrunc[0]?.prompt, "Prompt 1");
  assert.equal(extractedTrunc[1]?.role, "Agent2");
  assert.equal(extractedTrunc[1]?.prompt, "Prompt 2");
});
