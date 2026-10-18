import * as path from "node:path";
import { LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import type { LoopTestSummary, LoopTestStatus } from "../../shared/contracts.js";

export function isVerificationCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  const lower = cmd.toLowerCase().trim();
  const verifyPattern = /\b(test|typecheck|tsc|lint|check|verify|pytest|vitest|jest|cargo\s+test|ctest|mvn\s+test|gradlew\s+test)\b/i;
  return verifyPattern.test(lower);
}

export function isIsolationCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  const lower = cmd.toLowerCase().trim();
  const isolatePattern = /\b(git\s+worktree|docker\s+(inspect|ps|run|exec|compose)|devcontainer)\b/i;
  return isolatePattern.test(lower);
}

export function isStackDetectionTarget(target: string): boolean {
  if (!target || typeof target !== "string") return false;
  const lower = target.toLowerCase().trim();
  return /\b(package\.json|tsconfig\.json|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|dockerfile|composer\.json)\b/i.test(lower);
}

export function parseVerificationOutput(text: string, exitCode?: number): LoopTestSummary | null {
  if (!text && exitCode === undefined) return null;

  const raw = typeof text === "string" ? text : "";
  let passCount: number | null = null;
  let failCount: number | null = null;

  // 1. TAP format: # pass 4, # fail 0
  const tapPassMatch = /#\s*pass\s+(\d+)/i.exec(raw);
  const tapFailMatch = /#\s*fail\s+(\d+)/i.exec(raw);
  if (tapPassMatch || tapFailMatch) {
    passCount = tapPassMatch && tapPassMatch[1] ? parseInt(tapPassMatch[1], 10) : 0;
    failCount = tapFailMatch && tapFailMatch[1] ? parseInt(tapFailMatch[1], 10) : 0;
  }

  // 2. Jest/Vitest/Pytest format:
  // e.g., "Tests: 1 failed, 3 passed", "Tests 4 passed | 1 failed", "2 passed", "3 passed, 1 failed"
  if (passCount === null && failCount === null) {
    const passedMatch = /(\d+)\s+passed\b/i.exec(raw);
    const failedMatch = /(\d+)\s+failed\b/i.exec(raw);

    if (passedMatch || failedMatch) {
      passCount = passedMatch && passedMatch[1] ? parseInt(passedMatch[1], 10) : 0;
      failCount = failedMatch && failedMatch[1] ? parseInt(failedMatch[1], 10) : 0;
    }
  }

  // If explicit counts were found, they take precedence over exitCode
  if (passCount !== null && failCount !== null) {
    const status: LoopTestStatus = failCount > 0 ? "fail" : passCount > 0 ? "pass" : "idle";
    return {
      status,
      passCount,
      failCount,
      lastRunAt: new Date().toISOString()
    };
  }

  // 3. Fallback based on exitCode if verification finished without explicit count output
  if (exitCode !== undefined) {
    if (exitCode === 0) {
      return {
        status: "pass",
        passCount: 0,
        failCount: 0,
        lastRunAt: new Date().toISOString()
      };
    } else {
      return {
        status: "fail",
        passCount: 0,
        failCount: 1,
        lastRunAt: new Date().toISOString()
      };
    }
  }

  return null;
}

export interface PhaseDetectionResult {
  readonly phase: LoopPhase;
  readonly evidence: string;
}

export function detectPhaseWithEvidenceFromTranscriptStep(step: unknown): PhaseDetectionResult | null {
  if (!step) return null;

  // Normalize string inputs if passed directly
  let s: Record<string, unknown>;
  if (typeof step === "string") {
    s = { content: step };
  } else if (typeof step === "object") {
    s = step as Record<string, unknown>;
  } else {
    return null;
  }

  // 1. Subagent events, system messages, or notification envelopes must NEVER drive main loop phase transitions
  const isSystemOrSubagentMsg =
    s.type === "SYSTEM_MESSAGE" ||
    s.source === "SYSTEM" ||
    s.source === "SUBAGENT" ||
    s.is_subagent === true ||
    s.isSubagent === true ||
    s.subagent === true ||
    (typeof s.content === "string" && s.content.includes("<SYSTEM_MESSAGE>") && s.content.includes("sender="));

  if (isSystemOrSubagentMsg) {
    return null;
  }

  // 2. Check User Prompt & Loop Reset Intent (Absolute highest precedence on user turns)
  if (s.source === "USER" || s.source === "USER_EXPLICIT" || s.type === "USER_INPUT") {
    const text = typeof s.content === "string" ? s.content : "";
    if (
      s.step_index === 0 ||
      /\b(loop\s*m[oóớơ>a-z]*|new\s*loop|start\s*loop|chạy\s*loop|bắt\s*đầu\s*loop|reset\s*loop)\b/i.test(text) ||
      (/\bloop\b/i.test(text) && /\b(m[oóớơ>a-z]*|new|start|chạy|bắt\s*đầu|reset)\b/i.test(text))
    ) {
      return {
        phase: "INITIALIZE",
        evidence: s.step_index === 0 ? "user: initial prompt" : "user: new loop requested"
      };
    }
    return null;
  }

  const content = typeof s.content === "string" ? s.content : "";
  const thinking = typeof s.thinking === "string" ? s.thinking : "";

  // 3. Tier 1 (Highest Precedence for Model Steps): Explicit Canonical Phase Tag
  // Check content first (primary model output visible to user), then fallback to thinking
  // Uses global regex to capture the last explicit phase declaration in transcript step
  const tagRegex = /\[Phase:\s*(INITIALIZE|SPEC_GATE|ISOLATE|DETECT_STACKS|PLAN|EXECUTE|VERIFY|REALITY_CHECK|RELEASE_GATE|COMPLETE)\]/gi;
  let lastTagMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(content)) !== null) {
    lastTagMatch = m;
  }
  if (!lastTagMatch && thinking) {
    while ((m = tagRegex.exec(thinking)) !== null) {
      lastTagMatch = m;
    }
  }

  if (lastTagMatch && lastTagMatch[1]) {
    const p = lastTagMatch[1].toUpperCase() as LoopPhase;
    if ((LOOP_PHASES as readonly string[]).includes(p)) {
      return { phase: p, evidence: `tag: [Phase: ${p}]` };
    }
  }

  const candidates: PhaseDetectionResult[] = [];

  // 4. Tier 2: Check Deterministic Tool Calls
  if (Array.isArray(s.tool_calls) && s.tool_calls.length > 0) {
    for (const tc of s.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const name = String(call.name || "").toLowerCase().trim();
      const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};

      if (name === "invoke_subagent" || name.endsWith(".invoke_subagent") ||
          name === "manage_subagents" || name.endsWith(".manage_subagents") ||
          name === "send_message" || name.endsWith(".send_message")) {
        // Subagent background orchestration is NOT phase evidence for the main agent loop!
        continue;
      }

      if (name === "ask_question") {
        candidates.push({ phase: "SPEC_GATE", evidence: "tool: ask_question" });
      }

      if (name === "run_command") {
        const cmd = String(args.CommandLine || args.command || "").trim();
        if (isVerificationCommand(cmd)) {
          candidates.push({ phase: "VERIFY", evidence: `cmd: ${cmd}` });
        } else if (isIsolationCommand(cmd)) {
          candidates.push({ phase: "ISOLATE", evidence: `cmd: ${cmd}` });
        } else if (/\b(list_dir|find_by_name)\b/i.test(cmd) || isStackDetectionTarget(cmd)) {
          candidates.push({ phase: "DETECT_STACKS", evidence: `cmd: ${cmd}` });
        }
      }

      if (name === "list_dir" || name === "find_by_name") {
        candidates.push({ phase: "DETECT_STACKS", evidence: `tool: ${name}` });
      }

      if (name === "view_file" || name === "read_resource") {
        const targetPath = String(args.AbsolutePath || args.TargetFile || args.filePath || args.Uri || "").trim();
        if (isStackDetectionTarget(targetPath)) {
          candidates.push({ phase: "DETECT_STACKS", evidence: `inspect: ${path.basename(targetPath)}` });
        }
      }

      if (name === "craft_technical_prompt_with_gpt") {
        candidates.push({ phase: "PLAN", evidence: "tool: craft_technical_prompt_with_gpt" });
      }

      if (name === "call_mcp_tool") {
        const toolName = String(args.ToolName || args.tool_name || "").replace(/^"|"$/g, "").trim();
        const serverName = String(args.ServerName || args.server_name || "").replace(/^"|"$/g, "").trim();
        if (toolName === "craft_technical_prompt_with_gpt" || serverName === "gpt_architect") {
          candidates.push({ phase: "PLAN", evidence: "mcp: gpt_architect" });
        } else if (toolName.includes("codegraph") || serverName === "codegraph") {
          candidates.push({ phase: "PLAN", evidence: "mcp: codegraph" });
        }
      }

      if (name === "write_to_file" || name === "replace_file_content") {
        candidates.push({ phase: "EXECUTE", evidence: `tool: ${name}` });
      }
    }
  }

  // 5. Tier 3: Template Markers
  const combined = content + "\n" + thinking;
  if (combined.trim()) {
    const templateMatch = /\[(?:Template|Workflow)\s+Applied\]:\s*Loaded\s+([^\s]+\.md)/i.exec(combined);
    if (templateMatch && templateMatch[1]) {
      const tName = templateMatch[1].toLowerCase();
      if (tName.includes("spec-document")) {
        candidates.push({ phase: "SPEC_GATE", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("using-git-worktrees")) {
        candidates.push({ phase: "ISOLATE", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("writing-plans") || tName.includes("brainstorming")) {
        candidates.push({ phase: "PLAN", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("implementer-prompt")) {
        candidates.push({ phase: "EXECUTE", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("task-reviewer") || tName.includes("verification-before-completion")) {
        candidates.push({ phase: "VERIFY", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("reality-checker")) {
        candidates.push({ phase: "REALITY_CHECK", evidence: `template: ${templateMatch[1]}` });
      } else if (tName.includes("finishing-a-development-branch") || tName.includes("release")) {
        candidates.push({ phase: "RELEASE_GATE", evidence: `template: ${templateMatch[1]}` });
      }
    }

    // Direct plain-text keyword detection for early signals if not already covered
    if (/\blist_dir\s+package\.json\b/i.test(combined)) {
      candidates.push({ phase: "DETECT_STACKS", evidence: "list_dir package.json" });
    }

    // Reality check and release gate detection from text ONLY for model/assistant output (protects Golden Assertion 2)
    const isModelStep = s.source === "MODEL" || s.type === "PLANNER_RESPONSE";
    if (isModelStep) {
      if (
        /\b(all tests passed|tất cả tests đã pass|tests passed)\b/i.test(combined) ||
        /\b(reality check|reality audit|kiểm tra thực tế|pre-completion audit)\b/i.test(combined)
      ) {
        candidates.push({ phase: "REALITY_CHECK", evidence: "reality check reported" });
      } else if (
        /\b(release gate|ready for release|chờ nghiệm thu|sign-off|human sign-off)\b/i.test(combined)
      ) {
        candidates.push({ phase: "RELEASE_GATE", evidence: "release gate reported" });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Assertion: Select the furthest credible phase from deterministic tool/template candidates
  // e.g. write_to_file + tsc -> VERIFY
  candidates.sort((a, b) => {
    const idxA = (LOOP_PHASES as readonly string[]).indexOf(a.phase);
    const idxB = (LOOP_PHASES as readonly string[]).indexOf(b.phase);
    return idxB - idxA;
  });

  return candidates[0] || null;
}

export function detectPhaseFromTranscriptStep(step: unknown): LoopPhase | null {
  return detectPhaseWithEvidenceFromTranscriptStep(step)?.phase ?? null;
}

export interface ParsedGptTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly missTokens: number;
  readonly totalTokens: number;
}

export function parseGptTokenUsageLine(text: string): ParsedGptTokenUsage | null {
  const regex = /(?:[\[(]?(?:GPT Token Usage|Usage)[\])]?:\s*)?Input:\s*([\d,]+)(?:\s*\(Cached:\s*([\d,]+)\))?\s*\|\s*Output:\s*(?:(?:(?:Blueprint|Content):\s*([\d,]+)(?:\s*\|\s*Thinking:\s*([\d,]+))?)|([\d,]+))\s*\|\s*Total:\s*([\d,]+)/i;
  const match = regex.exec(text);
  if (!match) {
    return null;
  }

  const parseNum = (str?: string) => (str ? parseInt(str.replace(/,/g, ""), 10) : 0);

  const inputTokens = parseNum(match[1]);
  const rawCached = parseNum(match[2]);
  const cachedTokens = Math.min(inputTokens, Math.max(0, rawCached));
  const blueprintOrContent = parseNum(match[3]);
  const thinking = parseNum(match[4]);
  const rawOutput = parseNum(match[5]);
  const outputTokens = rawOutput > 0 ? rawOutput : blueprintOrContent + thinking;
  const totalTokens = parseNum(match[6]);
  const missTokens = Math.max(0, inputTokens - cachedTokens);

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    missTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens
  };
}

export type TranscriptEventOrigin = "main" | "subagent" | "unknown";

export interface ParsedSubagentInvocation {
  readonly id?: string | undefined;
  readonly role: string;
  readonly model: string;
  readonly prompt: string;
}

function parseSingleSubagentChunk(chunk: string): ParsedSubagentInvocation | null {
  // First attempt clean JSON parse by repairing trailing characters if needed
  let cleaned = chunk.trim();
  if (!cleaned.endsWith("}")) {
    const quoteMatches = cleaned.match(/(?<!\\)"/g);
    const quoteCount = quoteMatches ? quoteMatches.length : 0;
    if (quoteCount % 2 !== 0) {
      cleaned += '"';
    }
    cleaned += "}";
  }

  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === "object") {
      const id = obj.id ?? obj.conversationId;
      const role = obj.Role ?? obj.role ?? obj.TypeName ?? obj.type_name ?? obj.typeName ?? obj.name;
      const model = obj.Model ?? obj.model;
      const prompt = obj.Prompt ?? obj.prompt ?? obj.task ?? obj.instruction ?? obj.initialPrompt;
      const roleStr = role !== undefined && role !== null ? String(role).trim() : "";
      const promptStr = prompt !== undefined && prompt !== null ? String(prompt).trim() : "";
      const modelStr = model !== undefined && model !== null ? String(model).trim() : "inherit";
      if (roleStr || promptStr) {
        return {
          ...(id ? { id: String(id) } : {}),
          role: roleStr || "subagent",
          model: modelStr || "inherit",
          prompt: promptStr
        };
      }
    }
  } catch {
    // Fall back to regex field extraction confined strictly to this single chunk
  }

  const roleMatch = /"(?:Role|role|TypeName|type_name|typeName|name)"\s*:\s*"([^"\r\n]+)/i.exec(chunk);
  const modelMatch = /"(?:Model|model)"\s*:\s*"([^"\r\n]+)/i.exec(chunk);
  const promptMatch = /"(?:Prompt|prompt|task|instruction|initialPrompt)"\s*:\s*"((?:[^"\\]|\\.)*)/i.exec(chunk);

  const roleStr = roleMatch ? roleMatch[1]?.replace(/[\\"]+$/, "").trim() : "";
  const modelStr = modelMatch ? modelMatch[1]?.replace(/[\\"]+$/, "").trim() : "inherit";
  let promptStr = promptMatch ? promptMatch[1]?.replace(/[\\"]+$/, "") : "";
  if (promptStr) {
    try {
      promptStr = JSON.parse(`"${promptStr}"`);
    } catch {
      // Keep unescaped if parse fails
    }
  }

  if (roleStr || promptStr) {
    return {
      role: roleStr || "subagent",
      model: modelStr || "inherit",
      prompt: promptStr ? String(promptStr).trim() : ""
    };
  }

  return null;
}

function parseTruncatedSubagentsString(raw: string): ParsedSubagentInvocation[] {
  const results: ParsedSubagentInvocation[] = [];
  const arrayStart = raw.search(/["']?subagents["']?\s*:\s*\[/i);
  const searchSlice = arrayStart !== -1 ? raw.slice(arrayStart) : raw;

  // Split into independent object candidate blocks by scanning balanced braces
  let depth = 0;
  let inString = false;
  let escape = false;
  let memberStart = -1;

  for (let i = 0; i < searchSlice.length; i++) {
    const ch = searchSlice[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") {
        if (depth === 0) {
          memberStart = i;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && memberStart !== -1) {
          const chunk = searchSlice.slice(memberStart, i + 1);
          const parsed = parseSingleSubagentChunk(chunk);
          if (parsed) {
            results.push(parsed);
          }
          memberStart = -1;
        }
      }
    }
  }

  // If the last member was truncated before closing brace (depth > 0)
  if (depth > 0 && memberStart !== -1) {
    const chunk = searchSlice.slice(memberStart);
    const parsed = parseSingleSubagentChunk(chunk);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Extracts normalized subagent invocations from an invoke_subagent tool call or arguments.
 * Handles structured objects, JSON-encoded argument strings, and truncated JSON arrays.
 * Preserves member order and newlines without cross-member field pairing.
 */
export function extractSubagentInvocations(
  toolCall: unknown
): readonly ParsedSubagentInvocation[] {
  if (!toolCall || typeof toolCall !== "object") {
    return [];
  }

  const tc = toolCall as Record<string, unknown>;
  let args = tc.args !== undefined ? tc.args : tc;

  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as Record<string, unknown>;
    } catch {
      // Handled via truncated array parser below
    }
  }

  // 1. Structured args parsing
  if (args && typeof args === "object") {
    const rawArgs = args as Record<string, unknown>;
    let subagents = rawArgs.Subagents ?? rawArgs.subagents;

    if (typeof subagents === "string") {
      try {
        subagents = JSON.parse(subagents);
      } catch {
        // Handled via string parser below
      }
    }

    if (Array.isArray(subagents)) {
      const results: ParsedSubagentInvocation[] = [];
      for (const item of subagents) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = rec.id ?? rec.conversationId;
        const role = rec.Role ?? rec.role ?? rec.TypeName ?? rec.type_name ?? rec.typeName ?? rec.name;
        const model = rec.Model ?? rec.model;
        const prompt = rec.Prompt ?? rec.prompt ?? rec.task ?? rec.instruction ?? rec.initialPrompt;

        const roleStr = role !== undefined && role !== null ? String(role).trim() : "";
        const promptStr = prompt !== undefined && prompt !== null ? String(prompt).trim() : "";
        const modelStr = model !== undefined && model !== null ? String(model).trim() : "inherit";

        if (roleStr || promptStr) {
          results.push({
            ...(id ? { id: String(id) } : {}),
            role: roleStr || "subagent",
            model: modelStr || "inherit",
            prompt: promptStr
          });
        }
      }
      if (results.length > 0) {
        return Object.freeze(results);
      }
    }

    // Single subagent direct args format
    const role = rawArgs.Role ?? rawArgs.role ?? rawArgs.TypeName ?? rawArgs.type_name ?? rawArgs.typeName ?? rawArgs.name;
    const model = rawArgs.Model ?? rawArgs.model;
    const prompt = rawArgs.Prompt ?? rawArgs.prompt ?? rawArgs.task ?? rawArgs.instruction ?? rawArgs.initialPrompt;
    if (role !== undefined || prompt !== undefined) {
      const roleStr = role !== undefined && role !== null ? String(role).trim() : "";
      const promptStr = prompt !== undefined && prompt !== null ? String(prompt).trim() : "";
      const modelStr = model !== undefined && model !== null ? String(model).trim() : "inherit";
      if (roleStr || promptStr) {
        const id = rawArgs.id ?? rawArgs.conversationId;
        return Object.freeze([
          {
            ...(id ? { id: String(id) } : {}),
            role: roleStr || "subagent",
            model: modelStr || "inherit",
            prompt: promptStr
          }
        ]);
      }
    }
  }

  // 2. Fallback parser for truncated or string-encoded JSON array
  const rawString = typeof args === "string" ? args : typeof tc.args === "string" ? tc.args : "";
  if (rawString) {
    return Object.freeze(parseTruncatedSubagentsString(rawString));
  }

  return [];
}

