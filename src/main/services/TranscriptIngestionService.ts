import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { TelemetryService } from "./TelemetryService.js";
import { calculateEstimatedCostUsd } from "./TelemetryService.js";
import type { McpMonitorService } from "./McpMonitorService.js";
import type { LoopStateService } from "./LoopStateService.js";
import type { SubagentService } from "./SubagentService.js";
import type { HarnessService } from "./HarnessService.js";
import type { JsonValue } from "../../shared/contracts.js";
import type { UsageEvent, WorktreeAttribution } from "../../shared/usage.js";
import type { WorktreeAttributionService } from "./WorktreeAttributionService.js";
import { LOOP_PHASES, type LoopPhase } from "../../shared/phases.js";
import {
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep,
  parseGptTokenUsageLine,
  extractSubagentInvocations,
  type PhaseDetectionResult,
  type ParsedGptTokenUsage,
  type ParsedSubagentInvocation,
  type TranscriptEventOrigin
} from "./transcriptParsers.js";

export {
  isVerificationCommand,
  isIsolationCommand,
  isStackDetectionTarget,
  parseVerificationOutput,
  detectPhaseWithEvidenceFromTranscriptStep,
  detectPhaseFromTranscriptStep,
  parseGptTokenUsageLine,
  extractSubagentInvocations,
  type PhaseDetectionResult,
  type ParsedGptTokenUsage,
  type ParsedSubagentInvocation,
  type TranscriptEventOrigin
};

function extractConversationIds(text: string): string[] {
  const matches = text.matchAll(/"conversationId":\s*"([^"]+)"/g);
  const ids: string[] = [];
  for (const m of matches) {
    if (m[1]) ids.push(m[1]);
  }
  return ids;
}

function extractSystemMessageSender(text: string): string | undefined {
  const match = text.match(/sender=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : undefined;
}


export function readAntigravityOutputTail(
  markerText: string,
  allowedRoots?: readonly string[]
): string | null {
  if (!markerText || typeof markerText !== "string") return null;
  const match = /The output was large and was saved to:\s*(?:file:\/\/\/)?([^\r\n]+)/i.exec(markerText);
  if (!match || !match[1]) return null;

  let rawPath = match[1].trim().replace(/[>"\s]+$/, "");
  if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(rawPath)) {
    rawPath = rawPath.slice(1);
  }

  const resolved = path.resolve(rawPath);
  const homeDir = os.homedir();
  const roots = allowedRoots && allowedRoots.length > 0
    ? allowedRoots.map((r) => path.resolve(r))
    : [
        path.resolve(homeDir, ".gemini", "antigravity-cli", "brain"),
        path.resolve(homeDir, ".gemini", "antigravity", "brain")
      ];

  const canonicalTarget = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const isAllowed = roots.some((root) => {
    const canonicalRoot = process.platform === "win32" ? root.toLowerCase() : root;
    const prefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : canonicalRoot + path.sep;
    return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(prefix);
  });

  if (!isAllowed) return null;

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    const maxTailBytes = 8192;
    const readLen = Math.min(stat.size, maxTailBytes);
    const buffer = Buffer.alloc(readLen);
    const fd = fs.openSync(resolved, "r");
    try {
      fs.readSync(fd, buffer, 0, readLen, Math.max(0, stat.size - readLen));
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf-8");
  } catch {
    return null;
  }
}

export function isPathInsideOrEqual(candidateSubPath: string, rootPath: string): boolean {
  try {
    const normSub = path.resolve(candidateSubPath);
    const normRoot = path.resolve(rootPath);
    const s1 = process.platform === "win32" ? normSub.toLowerCase() : normSub;
    const r1 = process.platform === "win32" ? normRoot.toLowerCase() : normRoot;
    const rel = path.relative(r1, s1);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export function isTranscriptBelongingToProject(transcriptPath: string, projectRoot: string): boolean {
  function lineMatchesProjectOwnership(line: string, projectRoot: string): boolean {
    if (!line.trim()) return false;
    try {
      const step = JSON.parse(line);
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          if (tc && tc.args) {
            const args = typeof tc.args === "object" ? tc.args : {};
            const candidatePaths = [
              args.Cwd,
              args.SearchDirectory,
              args.AbsolutePath,
              args.TargetFile,
              args.projectPath,
              args.projectRoot,
              args.workspace
            ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);

            for (const p of candidatePaths) {
              const cleanP = p.replace(/^"|"$/g, "");
              if (isPathInsideOrEqual(cleanP, projectRoot)) {
                return true;
              }
            }
          }
        }
      }

      const textToCheck =
        (typeof step.content === "string" ? step.content : "") +
        "\n" +
        (typeof step.thinking === "string" ? step.thinking : "");
      if (textToCheck) {
        const wsMatches = textToCheck.matchAll(
          /(?:Active Workspaces|Command Working Directory|SearchDirectory|Cwd)[:\s-]+([^\r\n"']+)/gi
        );
        for (const m of wsMatches) {
          const rawWs = m[1]?.trim();
          if (rawWs && isPathInsideOrEqual(rawWs, projectRoot)) {
            return true;
          }
        }
      }
    } catch {
      // Continue inspecting next line
    }
    return false;
  }
  if (!fs.existsSync(transcriptPath)) return false;
  let fd: number | null = null;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return false;

    fd = fs.openSync(transcriptPath, "r");
    const maxScanBytes = Math.min(stat.size, 256 * 1024);
    const chunkSize = 64 * 1024;
    let offset = 0;
    const decoder = new StringDecoder("utf-8");
    let leftover = "";

    while (offset < maxScanBytes) {
      const bytesToRead = Math.min(chunkSize, maxScanBytes - offset);
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;

      const chunkStr = decoder.write(buffer.subarray(0, bytesRead));
      const text = leftover + chunkStr;
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        if (lineMatchesProjectOwnership(line, projectRoot)) {
          return true;
        }
      }
    }

    // Inspect remaining record at confirmed physical EOF within ceiling
    if (offset >= stat.size && leftover.trim()) {
      if (lineMatchesProjectOwnership(leftover, projectRoot)) {
        return true;
      }
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
  return false;
}

export class TranscriptIngestionService {
  private telemetryService: TelemetryService;
  private mcpService: McpMonitorService;
  private loopService: LoopStateService | null = null;
  private subagentService: SubagentService | null = null;
  private customTranscriptPath: string | null = null;
  private currentTranscriptPath: string | null = null;
  private lastOffset: number = 0;
  private incompleteLine: string = "";
  private discardUntilNewline: boolean = false;
  private stringDecoder = new StringDecoder("utf-8");
  private pollTimer: NodeJS.Timeout | null = null;
  private ingestionInFlight: boolean = false;
  private readonly MAX_INGESTION_CHUNK_BYTES = 64 * 1024; // 64 KiB

  // Queue of pending synthetic subagent ID batches awaiting tool result conversationIds
  private pendingSubagentsQueue: string[][] = [];

  // Deduplication registries for idempotent ingestion
  private seenToolCallKeys = new Set<string>();
  private seenGptEventKeys = new Set<string>();
  private seenGeminiStepIndices = new Set<number>();

  // Monotonic telemetry totals
  private totalGptPrompt = 0;
  private totalGptCompletion = 0;
  private totalGptCacheHit = 0;
  private totalGptCacheMiss = 0;
  private totalGeminiPrompt = 0;
  private totalGeminiCompletion = 0;
  private cumulativeContextLength = 30000;
  private sessionGeneration = 0;
  private projectRoot = process.cwd();
  private lastObservedRunId: string | null = null;
  private isDisposed = false;
  private allowedOutputRoots?: readonly string[] | undefined;
  private harnessService: HarnessService | null = null;
  private currentAttribution: WorktreeAttribution | null = null;
  private worktreeAttributionService: WorktreeAttributionService | null = null;

  constructor(
    telemetryService: TelemetryService,
    mcpService: McpMonitorService,
    loopServiceOrPath?: LoopStateService | string | null,
    customTranscriptPath?: string | null,
    subagentService?: SubagentService | null,
    allowedOutputRoots?: readonly string[]
  ) {
    this.telemetryService = telemetryService;
    this.mcpService = mcpService;
    if (typeof loopServiceOrPath === "string") {
      this.customTranscriptPath = loopServiceOrPath;
      this.loopService = null;
    } else {
      this.loopService = loopServiceOrPath ?? null;
      this.customTranscriptPath = customTranscriptPath ?? null;
    }
    this.subagentService = subagentService ?? null;
    this.allowedOutputRoots = allowedOutputRoots;

    if (this.loopService && typeof this.loopService.onRunReset === "function") {
      this.loopService.onRunReset(() => {
        this.resetRunCounters();
      });
    }
  }

  setSubagentService(subagentService: SubagentService | null): void {
    this.subagentService = subagentService;
  }

  setAllowedOutputRoots(roots?: readonly string[]): void {
    this.allowedOutputRoots = roots;
  }

  setHarnessService(harnessService: HarnessService | null): void {
    this.harnessService = harnessService;
  }

  setWorktreeAttribution(attribution: WorktreeAttribution | null): void {
    this.currentAttribution = attribution;
  }

  getWorktreeAttribution(): WorktreeAttribution | null {
    return this.currentAttribution;
  }

  setWorktreeAttributionService(service: WorktreeAttributionService | null): void {
    this.worktreeAttributionService = service;
    if (service && this.projectRoot) {
      void service.resolve(this.projectRoot).then((attr) => {
        if (attr) {
          this.currentAttribution = attr;
        }
      });
    }
  }

  getSessionGeneration(): number {
    return this.sessionGeneration;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  async setProjectRoot(projectPath: string): Promise<void> {
    this.sessionGeneration++;
    this.projectRoot = path.resolve(projectPath);
    this.resetSessionCounters();
    this.lastOffset = 0;
    this.incompleteLine = "";
    this.discardUntilNewline = false;
    this.currentTranscriptPath = null;
    if (this.harnessService) {
      const projId = path.basename(this.projectRoot).replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
      await this.harnessService.switchRun(`run_${projId}`);
    }
  }

  reset(): void {
    this.sessionGeneration++;
    this.resetSessionCounters();
    this.lastOffset = 0;
    this.incompleteLine = "";
    this.discardUntilNewline = false;
    this.stringDecoder = new StringDecoder("utf-8");
    this.currentTranscriptPath = null;
  }

  resetSessionCounters(): void {
    this.seenToolCallKeys.clear();
    this.seenGptEventKeys.clear();
    this.seenGeminiStepIndices.clear();
    this.pendingSubagentsQueue = [];
    this.totalGptPrompt = 0;
    this.totalGptCompletion = 0;
    this.totalGptCacheHit = 0;
    this.totalGptCacheMiss = 0;
    this.totalGeminiPrompt = 0;
    this.totalGeminiCompletion = 0;
    this.cumulativeContextLength = 30000;
  }

  resetRunCounters(): void {
    this.resetSessionCounters();
    if (this.loopService) {
      this.loopService.updateResourceUsage({
        costMicroUsd: 0,
        promptTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        oracleCalls: 0,
        globalCycles: 0,
        verificationRetries: 0,
        qualityRemediations: 0
      });
    }
    this.telemetryService.updateMetrics({
      gptPromptTokens: 0,
      gptCompletionTokens: 0,
      geminiPromptTokens: 0,
      geminiCompletionTokens: 0,
      estimatedCostUsd: 0
    });
  }

  findActiveTranscriptPath(): string | null {
    if (this.customTranscriptPath && fs.existsSync(this.customTranscriptPath)) {
      return this.customTranscriptPath;
    }

    // PINNED SESSION INVARIANT:
    // Once currentTranscriptPath is pinned to an active project transcript,
    // background subagent writes with newer mtime MUST NOT hijack the session!
    if (this.currentTranscriptPath && fs.existsSync(this.currentTranscriptPath)) {
      return this.currentTranscriptPath;
    }

    const homeDir = process.env.USERPROFILE || process.env.HOME || "";
    const searchRoots = [
      path.join(homeDir, ".gemini", "antigravity-cli", "brain"),
      path.join(homeDir, ".gemini", "antigravity", "brain")
    ];

    let newestPath: string | null = null;
    let newestMtime = 0;
    const knownSubagentIds = this.subagentService?.getAllSubagentIds() ?? new Set<string>();

    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        const convDirs = fs.readdirSync(root, { withFileTypes: true });
        for (const dir of convDirs) {
          if (!dir.isDirectory()) continue;
          if (knownSubagentIds.has(dir.name)) continue;

          const candidate = path.join(root, dir.name, ".system_generated", "logs", "transcript.jsonl");
          if (fs.existsSync(candidate)) {
            const belongs = isTranscriptBelongingToProject(candidate, this.projectRoot);
            if (!belongs) {
              continue;
            }

            const stat = fs.statSync(candidate);
            if (
              stat.mtimeMs > newestMtime ||
              (stat.mtimeMs === newestMtime && (!newestPath || candidate < newestPath))
            ) {
              newestMtime = stat.mtimeMs;
              newestPath = candidate;
            }
          }
        }
      } catch {
        // Ignore unreadable dirs
      }
    }

    return newestPath;
  }

  processLine(line: string, generation?: number): void {
    if (generation !== undefined && generation !== this.sessionGeneration) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;

    let step: any;
    try {
      step = JSON.parse(trimmed);
    } catch {
      let textToCheck = trimmed;
      const tailContent = readAntigravityOutputTail(trimmed);
      if (tailContent) {
        textToCheck += "\n" + tailContent;
      }
      const gptUsage = parseGptTokenUsageLine(textToCheck);
      if (gptUsage) {
        const eventKey = "raw:" + trimmed;
        if (!this.seenGptEventKeys.has(eventKey)) {
          this.seenGptEventKeys.add(eventKey);
          this.totalGptPrompt += gptUsage.inputTokens;
          this.totalGptCompletion += gptUsage.outputTokens;
          this.totalGptCacheHit += gptUsage.cachedTokens;
          this.totalGptCacheMiss += gptUsage.missTokens;

          this.telemetryService.updateMetrics({
            gptPromptTokens: this.totalGptPrompt,
            gptCompletionTokens: this.totalGptCompletion,
            gptCacheHitTokens: this.totalGptCacheHit,
            gptCacheMissTokens: this.totalGptCacheMiss
          });
        }
      }
      return;
    }

    const stepIdx = typeof step.step_index === "number" ? step.step_index : Date.now();

    // Cumulative context tracking on user turn (observational only; must not reset loop)
    if (step.source === "USER_EXPLICIT" || step.source === "USER" || step.type === "USER_INPUT") {
      const userContent = typeof step.content === "string" ? step.content : "";
      this.cumulativeContextLength += userContent.length;
    }

    // 1. Process Tool Calls (Layer 1 Assertion 5: dedupe step.tool_calls)
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      for (let i = 0; i < step.tool_calls.length; i++) {
        const tc = step.tool_calls[i];
        if (!tc || typeof tc !== "object") continue;

        let serverName = "native";
        let toolName = String(tc.name || "unknown");
        let args: JsonValue | undefined = undefined;

        if (tc.args !== undefined) {
          if (typeof tc.args === "string") {
            try {
              args = JSON.parse(tc.args) as JsonValue;
            } catch {
              args = tc.args;
            }
          } else {
            args = tc.args as unknown as JsonValue;
          }
        }

        if (tc.name === "call_mcp_tool" && tc.args) {
          const rawServer = tc.args.ServerName || tc.args.server_name || "unknown";
          const rawTool = tc.args.ToolName || tc.args.tool_name || "unknown";
          serverName = String(rawServer).replace(/^"|"$/g, "");
          toolName = String(rawTool).replace(/^"|"$/g, "");

          const innerArgs = tc.args.Arguments || tc.args.arguments || tc.args.args;
          if (innerArgs !== undefined) {
            if (typeof innerArgs === "string") {
              try {
                args = JSON.parse(innerArgs) as JsonValue;
              } catch {
                args = innerArgs;
              }
            } else {
              args = innerArgs as unknown as JsonValue;
            }
          }
        }

        let rawTimestamp: number | undefined;
        if (typeof step.created_at === "string") {
          const parsedMs = new Date(step.created_at).getTime();
          if (Number.isFinite(parsedMs) && parsedMs >= 0) {
            rawTimestamp = parsedMs;
          }
        } else if (typeof step.created_at === "number" && Number.isFinite(step.created_at) && step.created_at >= 0) {
          rawTimestamp = step.created_at;
        }

        const callKey = stepIdx + ":" + i + ":" + serverName + ":" + toolName;
        if (!this.seenToolCallKeys.has(callKey)) {
          this.seenToolCallKeys.add(callKey);
          this.mcpService.recordToolCall({
            serverName,
            toolName,
            status: step.status === "ERROR" ? "error" : "success",
            args,
            ...(rawTimestamp !== undefined ? { timestamp: rawTimestamp } : {})
          });

          if (this.harnessService) {
            const guardArgs = (args && typeof args === "object" ? args : {}) as Readonly<Record<string, unknown>>;
            const guardDecision = this.harnessService.checkToolCall(toolName, guardArgs);
            if (!guardDecision.allowed) {
              void this.harnessService.recordEvent({
                source: "guard",
                kind: "tool_blocked",
                data: {
                  tool: toolName,
                  reasonCode: guardDecision.reasonCode || "REPEAT_TOOL_DETECTED",
                  message: guardDecision.message || "Execution blocked by ExecutionGuard"
                }
              });
            } else {
              this.harnessService.recordToolDispatch(toolName, guardArgs);
              void this.harnessService.recordEvent({
                source: "tool",
                kind: "tool_dispatch",
                data: {
                  server: serverName,
                  tool: toolName,
                  ...(args !== undefined && typeof args === "object" ? { args: guardArgs } : {})
                }
              });
            }
          }

          if (this.subagentService && (toolName === "invoke_subagent" || toolName.endsWith(".invoke_subagent"))) {
            this.handleSubagentToolCall(step, tc, stepIdx, i);
          } else if (this.subagentService && (toolName === "manage_subagents" || toolName.endsWith(".manage_subagents"))) {
            this.handleManageSubagentsToolCall(tc);
          }
        }
      }
    }

    // Correlated subagent tool results or lifecycle updates
    if (this.subagentService) {
      if (step.tool_call_id && (step.type === "TOOL_RESULT" || step.source === "TOOL_RESULT")) {
        const resultId = String(step.tool_call_id);
        if (step.is_error || step.status === "ERROR") {
          this.subagentService.updateStatus({
            id: resultId,
            status: "error",
            errorMessage: typeof step.content === "string" ? step.content : "Tool execution error"
          });
        } else if (step.status === "DONE" || step.type === "SUBAGENT_COMPLETED") {
          this.subagentService.updateStatus({
            id: resultId,
            status: "completed"
          });
        }
      } else if (step.sender && typeof step.sender === "string" && step.type === "SUBAGENT_COMPLETED") {
        this.subagentService.updateStatus({
          id: step.sender,
          status: "completed"
        });
      }

      if (typeof step.content === "string") {
        this.handleSubagentOutput(step.content, step);
      }
    }

    // Check run boundary: auto-reset counters if runId has changed
    if (this.loopService) {
      const snap = this.loopService.getSnapshot();
      if (this.lastObservedRunId !== null && snap.runId && snap.runId !== this.lastObservedRunId) {
        this.resetRunCounters();
        if (this.harnessService && snap.runId) {
          void this.harnessService.switchRun(snap.runId);
        }
      }
      this.lastObservedRunId = snap.runId || null;
    }

    // 2. Process GPT Token Metrics (Layer 1 Assertion 4: dedupe usage)
    const content = typeof step.content === "string" ? step.content : "";
    const thinking = typeof step.thinking === "string" ? step.thinking : "";
    let combinedText = content + "\n" + thinking;
    const tailContent = readAntigravityOutputTail(content, this.allowedOutputRoots);
    if (tailContent) {
      combinedText += "\n" + tailContent;
    }

    const gptUsage = parseGptTokenUsageLine(combinedText);
    if (gptUsage) {
      const gptKey = "step:" + stepIdx + ":" + gptUsage.totalTokens;
      if (!this.seenGptEventKeys.has(gptKey)) {
        this.seenGptEventKeys.add(gptKey);
        this.totalGptPrompt += gptUsage.inputTokens;
        this.totalGptCompletion += gptUsage.outputTokens;
        this.totalGptCacheHit += gptUsage.cachedTokens;
        this.totalGptCacheMiss += gptUsage.missTokens;

        this.telemetryService.updateMetrics({
          gptPromptTokens: this.totalGptPrompt,
          gptCompletionTokens: this.totalGptCompletion,
          gptCacheHitTokens: this.totalGptCacheHit,
          gptCacheMissTokens: this.totalGptCacheMiss
        });

        if (this.loopService) {
          const totalGpt = this.totalGptPrompt + this.totalGptCompletion;
          this.loopService.updateResourceUsage({
            promptTokens: this.totalGptPrompt,
            completionTokens: this.totalGptCompletion,
            cachedTokens: this.totalGptCacheHit,
            totalTokens: totalGpt,
            oracleCalls: this.seenGptEventKeys.size
          });
        }

        const occurredAt = typeof step.created_at === "string" ? step.created_at : new Date().toISOString();
        const eventId = `gpt:${this.currentTranscriptPath || "default"}:${stepIdx}:${gptUsage.totalTokens}`;
        const cost = calculateEstimatedCostUsd(gptUsage.inputTokens, gptUsage.outputTokens, gptUsage.cachedTokens);
        this.telemetryService.recordUsageEvent({
          id: eventId,
          sourceId: this.currentTranscriptPath || "default",
          sourceEventId: String(stepIdx),
          occurredAt,
          provider: "openai",
          tool: "gpt_architect",
          model: "gpt-6.1-sol",
          runId: this.loopService?.getSnapshot().runId ?? null,
          agentId: null,
          sessionId: this.currentTranscriptPath || null,
          tokens: {
            inputTokens: gptUsage.inputTokens,
            outputTokens: gptUsage.outputTokens,
            cachedInputTokens: gptUsage.cachedTokens
          },
          estimatedCostUsd: cost,
          pricingVersion: "1.0",
          attribution: this.currentAttribution
        });
      }
    }

    // 3. Process Gemini Telemetry (Subagent events must not increment main agent telemetry)
    const isSubagentStep =
      step.is_subagent === true ||
      step.isSubagent === true ||
      step.subagent === true ||
      step.source === "SUBAGENT" ||
      (step.conversationId && this.subagentService?.isSubagent(String(step.conversationId))) ||
      (step.conversation_id && this.subagentService?.isSubagent(String(step.conversation_id))) ||
      (step.sender && this.subagentService?.isSubagent(String(step.sender)) && (step.source === "SYSTEM" || step.type === "SYSTEM_MESSAGE"));

    if (!isSubagentStep && step.source === "MODEL" && typeof step.step_index === "number") {
      if (!this.seenGeminiStepIndices.has(step.step_index)) {
        this.seenGeminiStepIndices.add(step.step_index);

        const isValidTokenNumber = (v: unknown): v is number =>
          typeof v === "number" && Number.isFinite(v) && v >= 0;

        const rootInput = isValidTokenNumber(step.input_tokens) ? step.input_tokens : undefined;
        const rootOutput = isValidTokenNumber(step.output_tokens) ? step.output_tokens : undefined;

        const usageInput = step.usage && isValidTokenNumber(step.usage.prompt_tokens)
          ? step.usage.prompt_tokens
          : step.usage && isValidTokenNumber(step.usage.input_tokens)
            ? step.usage.input_tokens
            : undefined;

        const usageOutput = step.usage && isValidTokenNumber(step.usage.completion_tokens)
          ? step.usage.completion_tokens
          : step.usage && isValidTokenNumber(step.usage.output_tokens)
            ? step.usage.output_tokens
            : undefined;

        const estPrompt = rootInput !== undefined
          ? rootInput
          : usageInput !== undefined
            ? usageInput
            : Math.max(1000, Math.ceil(this.cumulativeContextLength / 4));

        const estComp = rootOutput !== undefined
          ? rootOutput
          : usageOutput !== undefined
            ? usageOutput
            : Math.max(1, Math.ceil((content.length + thinking.length) / 4));

        this.cumulativeContextLength += content.length + thinking.length;
        // Invariant: Gemini prompt tokens represent the current active context window,
        // while completion tokens represent the cumulative generation output across steps.
        this.totalGeminiPrompt = estPrompt;
        this.totalGeminiCompletion += estComp;

        this.telemetryService.updateMetrics({
          geminiPromptTokens: this.totalGeminiPrompt,
          geminiCompletionTokens: this.totalGeminiCompletion,
          geminiCacheStatus: "Active"
        });

        if (this.loopService) {
          // Loop resourceUsage tracks actual consumed workload tokens for the current run.
          // It MUST NOT include the static context window size (estPrompt) of the host LLM,
          // which would artificially deplete the 120,000 token loop run budget.
          const totalLoopTokens = (this.totalGptPrompt + this.totalGptCompletion) + this.totalGeminiCompletion;
          this.loopService.updateResourceUsage({
            promptTokens: this.totalGptPrompt,
            completionTokens: this.totalGptCompletion + this.totalGeminiCompletion,
            cachedTokens: this.totalGptCacheHit,
            totalTokens: totalLoopTokens
          });
        }
      }
    }

    // 4. Process Workflow Phase Detection & Auto-Transition
    const detection = detectPhaseWithEvidenceFromTranscriptStep(step);
    if (detection && this.loopService) {
      const current = this.loopService.getSnapshot();
      const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
      const targetIdx = LOOP_PHASES.indexOf(detection.phase);
      // Invariant: Transcript evidence is forward-only.
      // Casual inspections (list_dir, view_file, codegraph) during EXECUTE or VERIFY
      // must NOT attempt to rewind the active workflow.
      if (targetIdx > currentIdx || detection.phase === "INITIALIZE") {
        this.loopService.advanceToPhase(detection.phase, detection.evidence);
        if (this.harnessService) {
          void this.harnessService.recordEvent({
            source: "loop",
            kind: "phase_transition",
            data: {
              targetPhase: detection.phase,
              ...(detection.evidence ? { evidence: detection.evidence } : {})
            }
          });
        }
      }
    }

    // 5. Process Verification Test Results
    const testResult = parseVerificationOutput(combinedText);
    if (testResult && this.loopService) {
      this.loopService.updateTestSummary(testResult);
      if (testResult.status === "pass" && testResult.failCount === 0) {
        const current = this.loopService.getSnapshot();
        const currentIdx = LOOP_PHASES.indexOf(current.currentPhase as LoopPhase);
        const verifyIdx = LOOP_PHASES.indexOf("VERIFY");
        if (currentIdx <= verifyIdx) {
          this.loopService.advanceToPhase("REALITY_CHECK", `Tests passed (${testResult.passCount} passed, 0 failed)`);
        }
      } else if (testResult.status === "fail" && testResult.failCount > 0) {
        // Explicit loopback to EXECUTE on test failure
        const current = this.loopService.getSnapshot();
        if (current.currentPhase === "VERIFY" && current.usage.retries < current.budget.maxRetries) {
          this.loopService.advanceToPhase(
            "EXECUTE",
            `Test failure detected (${testResult.failCount} failed)`,
            "verify-test-failure"
          );
        }
      }
    }
  }

  processFile(): void {
    if (this.isDisposed || this.ingestionInFlight) {
      return;
    }
    this.ingestionInFlight = true;
    try {
      this.ingestCurrentFile(this.sessionGeneration);
    } catch {
      // Defensive error handling: ignore transient read error
    } finally {
      this.ingestionInFlight = false;
    }
  }

  private ingestCurrentFile(generation: number): void {
    if (this.isDisposed || this.sessionGeneration !== generation) {
      return;
    }
    const targetFile = this.customTranscriptPath || this.findActiveTranscriptPath();
    if (this.isDisposed || this.sessionGeneration !== generation) {
      return;
    }
    if (!targetFile || !fs.existsSync(targetFile)) {
      return;
    }

    if (targetFile !== this.currentTranscriptPath) {
      const isSwitchingSession = this.currentTranscriptPath !== null;
      this.currentTranscriptPath = targetFile;
      this.lastOffset = 0;
      this.incompleteLine = "";
      this.discardUntilNewline = false;
      this.stringDecoder = new StringDecoder("utf-8");

      if (isSwitchingSession) {
        this.resetSessionCounters();
        this.telemetryService.resetCurrentSession();
        if (this.loopService) {
          this.loopService.resetLoop();
        }
      }
    }

    try {
      const stat = fs.statSync(targetFile);
      if (this.sessionGeneration !== generation) return;

      if (stat.size < this.lastOffset) {
        this.lastOffset = 0;
        this.incompleteLine = "";
        this.discardUntilNewline = false;
        this.stringDecoder = new StringDecoder("utf-8");
      }

      if (stat.size === this.lastOffset) {
        return;
      }

      let fd: number | null = null;
      try {
        fd = fs.openSync(targetFile, "r");
        while (this.lastOffset < stat.size) {
          if (this.sessionGeneration !== generation) break;

          const bytesToRead = Math.min(stat.size - this.lastOffset, this.MAX_INGESTION_CHUNK_BYTES);
          if (bytesToRead <= 0) break;

          const buffer = Buffer.alloc(bytesToRead);
          const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, this.lastOffset);
          if (bytesRead <= 0) break;

          this.lastOffset += bytesRead;

          let chunkStr = this.stringDecoder.write(buffer.subarray(0, bytesRead));
          if (this.discardUntilNewline) {
            const newlineIdx = chunkStr.indexOf("\n");
            if (newlineIdx !== -1) {
              chunkStr = chunkStr.slice(newlineIdx + 1);
              this.discardUntilNewline = false;
            } else {
              continue;
            }
          }

          const raw = this.incompleteLine + chunkStr;
          const lines = raw.split(/\r?\n/);
          this.incompleteLine = lines.pop() ?? "";

          for (const line of lines) {
            if (this.sessionGeneration !== generation) return;
            const fullLine = this.resolveFullLineIfTruncated(line, targetFile);
            this.processLine(fullLine, generation);
          }

        }
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close error
          }
        }
      }
    } catch {
      // Defensive handling
    }
  }

  private resolveFullLineIfTruncated(line: string, targetFile: string): string {
    if (!line.includes('"truncated_fields"')) {
      return line;
    }
    try {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed.truncated_fields) || !parsed.truncated_fields.includes("tool_calls")) {
        return line;
      }
      const fullTranscriptPath = path.join(path.dirname(targetFile), "transcript_full.jsonl");
      if (!fs.existsSync(fullTranscriptPath)) {
        return line;
      }
      const targetStepIndex = parsed.step_index;
      if (typeof targetStepIndex !== "number") {
        return line;
      }
      const fullContent = fs.readFileSync(fullTranscriptPath, "utf-8");
      const fullLines = fullContent.split(/\r?\n/);
      if (fullLines[targetStepIndex]) {
        try {
          const cand = JSON.parse(fullLines[targetStepIndex]);
          if (cand.step_index === targetStepIndex) {
            return fullLines[targetStepIndex];
          }
        } catch {
          // Continue searching
        }
      }
      for (const fLine of fullLines) {
        if (!fLine.trim()) continue;
        if (fLine.includes(`"step_index":${targetStepIndex}`) || fLine.includes(`"step_index": ${targetStepIndex}`)) {
          return fLine;
        }
      }
    } catch {
      // Ignore error and fall back to original line
    }
    return line;
  }

  private handleSubagentToolCall(step: any, tc: any, stepIdx: number, toolIdx: number): void {
    if (!this.subagentService) return;

    const invocations = extractSubagentInvocations(tc);
    if (invocations.length === 0) {
      return;
    }

    const batchIds: string[] = [];
    for (let sIdx = 0; sIdx < invocations.length; sIdx++) {
      const item = invocations[sIdx];
      if (!item) continue;
      const subId = item.id || `${stepIdx}:sub:${toolIdx}:${sIdx}`;

      this.subagentService.recordInvocation({
        id: String(subId),
        role: item.role,
        model: item.model,
        prompt: item.prompt,
        startedAt: typeof step?.created_at === "string" ? new Date(step.created_at).getTime() : undefined
      });

      batchIds.push(String(subId));

      if (step?.status === "ERROR") {
        this.subagentService.updateStatus({
          id: String(subId),
          status: "error",
          errorMessage: typeof step.content === "string" ? step.content : "Subagent error"
        });
      }
    }

    if (batchIds.length > 0 && step?.status !== "ERROR") {
      this.pendingSubagentsQueue.push(batchIds);
    }
  }

  private handleManageSubagentsToolCall(tc: any): void {
    if (!this.subagentService) return;
    let args = tc.args || {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    const action = String(args.Action || args.action || "").toLowerCase();
    if (action === "kill_all") {
      this.subagentService.markAllCompleted();
    } else if (action === "kill") {
      const ids = args.ConversationIds || args.conversationIds || args.conversationId || args.id;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string") {
            this.subagentService.markCompletedByConversationId(id);
          }
        }
      } else if (typeof ids === "string") {
        this.subagentService.markCompletedByConversationId(ids);
      }
    }
  }

  private handleSubagentOutput(content: string, step?: unknown): void {
    if (!this.subagentService) return;

    if (content.includes("conversationId")) {
      const ids = extractConversationIds(content);
      if (ids.length > 0 && this.pendingSubagentsQueue.length > 0) {
        const batch = this.pendingSubagentsQueue.shift();
        if (batch) {
          const limit = Math.min(batch.length, ids.length);
          for (let i = 0; i < limit; i++) {
            const subId = batch[i];
            const convId = ids[i];
            if (subId && convId) {
              this.subagentService.bindConversationId(subId, convId);
            }
          }
        }
      }
    }

    const stepObj = step && typeof step === "object" ? (step as Record<string, unknown>) : undefined;
    const explicitSender =
      typeof stepObj?.sender === "string" && stepObj.sender.trim()
        ? stepObj.sender.trim()
        : undefined;
    const sender = explicitSender || extractSystemMessageSender(content);

    if (sender && this.subagentService.isSubagent(sender)) {
      const taskIdMatch = /Task\s+id\s+"([^"]+)"/i.exec(content);
      const taskId = taskIdMatch ? taskIdMatch[1] : undefined;

      // If a task ID is explicitly specified, ensure it belongs to the sender or a known subagent
      const taskMatchesSender = !taskId || taskId === sender || this.subagentService.isSubagent(taskId);

      if (taskMatchesSender) {
        const isExplicitDone =
          /\bTask\s+id\s+"[^"]+"\s+(?:finished with result|was completed with result)\b/i.test(content) ||
          /\b(?:finished with result|was completed with result)\s*:/i.test(content) ||
          /\bcontent=Done\b/i.test(content) ||
          /\bcontent=Done\s+/i.test(content) ||
          stepObj?.type === "SUBAGENT_COMPLETED";

        const isExplicitError =
          /\bTask\s+id\s+"[^"]+"\s+(?:failed with error|terminated with error|was canceled with result)\b/i.test(content) ||
          /\b(?:failed with error|terminated with error)\s*:/i.test(content) ||
          /\berrored out\b/i.test(content);

        const targetSubagentId = (taskId && this.subagentService.isSubagent(taskId)) ? taskId : sender;

        if (isExplicitDone) {
          this.subagentService.markCompletedByConversationId(targetSubagentId);
        } else if (isExplicitError) {
          this.subagentService.updateStatus({
            id: targetSubagentId,
            status: "error",
            errorMessage: content
          });
        }
      }
    }

    if (content.includes("Successfully killed")) {
      this.subagentService.markAllCompleted();
    } else if (content.includes('"state":"idle"')) {
      const idleMatches = content.matchAll(/"conversationId":\s*"([^"]+)",[^}]*"state":\s*"idle"/g);
      for (const m of idleMatches) {
        if (m[1]) {
          this.subagentService.markIdleByConversationId(m[1]);
        }
      }
    }
  }

  start(): void {
    this.processFile();
    this.pollTimer = setInterval(() => {
      this.processFile();
    }, 1500);
  }

  dispose(): void {
    this.isDisposed = true;
    this.sessionGeneration++;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
