import React, { useEffect, useState, useCallback, useRef } from "react";
import type {
  CockpitApi,
  LoopStateSnapshot,
  McpSnapshot,
  CriticalLogEntry,
  TelemetrySnapshot,
  EvalHarnessSnapshot,
  SubagentActivity
} from "../shared/contracts.js";
import { LOOP_PHASES, computePhaseStatuses } from "../shared/phases.js";
import { PhaseTracker } from "./components/PhaseTracker.js";
import { TerminalStage } from "./components/TerminalStage.js";
import { McpSidebar } from "./components/McpSidebar.js";
import { SubagentSidebar } from "./components/SubagentSidebar.js";
import { CriticalLogDrawer } from "./components/CriticalLogDrawer.js";
import { TelemetryHud } from "./components/TelemetryHud.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
import { EvalScoreboard } from "./components/EvalScoreboard.js";
import { RunActivityPanel } from "./components/RunActivityPanel.js";
import { SystemReadinessModal } from "./components/SystemReadinessModal.js";
import type { SystemReadinessSnapshot } from "../shared/systemReadiness.js";
import type { SessionEvent } from "../shared/harnessContracts.js";
import type { PollableBridge } from "./vite-env.js";
import "./styles/cockpit.css";

const DEFAULT_LOOP_STATE: LoopStateSnapshot = {
  runId: "init",
  schemaVersion: 1,
  revision: 1,
  currentPhase: LOOP_PHASES[0],
  status: "ready",
  usage: { transitions: 0, retries: 0, operations: 0 },
  budget: { maxTransitions: 25, maxRetries: 2, maxOperations: 50 },
  resourceBudget: {
    maxCostMicroUsd: 1_000_000,
    maxTokens: 180_000,
    maxOracleCalls: 2,
    maxGlobalCycles: 2,
    maxVerificationRetries: 1,
    maxQualityRemediations: 1
  },
  resourceUsage: {
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
  },
  phases: computePhaseStatuses(LOOP_PHASES[0]),
  lastUpdated: Date.now()
};

const DEFAULT_MCP_STATE: McpSnapshot = {
  servers: [],
  recentCalls: [],
  lastUpdated: Date.now()
};

const DEFAULT_USAGE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const DEFAULT_METRICS = { gpt: DEFAULT_USAGE, gemini: DEFAULT_USAGE, estimatedCostUsd: 0 };

const DEFAULT_TELEMETRY: TelemetrySnapshot = {
  gptPromptTokens: null,
  gptCompletionTokens: null,
  gptCacheHitTokens: null,
  gptCacheMissTokens: null,
  gptCacheHitPercentage: null,
  geminiPromptTokens: null,
  geminiCompletionTokens: null,
  geminiCacheStatus: "Unavailable",
  estimatedCostUsd: null,
  budgetLimitUsd: 0.50,
  dockerStatus: "Unavailable",
  lastUpdated: Date.now(),
  currentSession: DEFAULT_METRICS,
  allTime: DEFAULT_METRICS
};

const DEFAULT_EVAL_STATE: EvalHarnessSnapshot = {
  status: "idle",
  report: null,
  updatedAt: null,
  error: null
};

export const App: React.FC = () => {
  const [loopState, setLoopState] = useState<LoopStateSnapshot>(DEFAULT_LOOP_STATE);
  const [mcpState, setMcpState] = useState<McpSnapshot>(DEFAULT_MCP_STATE);
  const [logs, setLogs] = useState<readonly CriticalLogEntry[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(DEFAULT_TELEMETRY);
  const [evalSnapshot, setEvalSnapshot] = useState<EvalHarnessSnapshot>(DEFAULT_EVAL_STATE);
  const [subagents, setSubagents] = useState<readonly SubagentActivity[]>([]);
  const [activeTab, setActiveTab] = useState<"terminal" | "eval" | "activity">("terminal");
  const [harnessEvents, setHarnessEvents] = useState<readonly SessionEvent[]>([]);
  const [rightSidebarTab, setRightSidebarTab] = useState<"mcp" | "subagents">("mcp");

  const [bridgeConnected, setBridgeConnected] = useState<boolean>(true);

  const [readinessSnapshot, setReadinessSnapshot] = useState<SystemReadinessSnapshot | null>(null);
  const [readinessModalOpen, setReadinessModalOpen] = useState<boolean>(false);
  const [readinessRefreshing, setReadinessRefreshing] = useState<boolean>(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const hasDismissedReadinessRef = useRef<boolean>(false);
  const lastWasDegradedRef = useRef<boolean>(false);

  const handleReadinessSnapshot = useCallback((snapshot: SystemReadinessSnapshot) => {
    setReadinessSnapshot(snapshot);
    setReadinessError(null);
    if (!snapshot.ready) {
      if (!lastWasDegradedRef.current) {
        lastWasDegradedRef.current = true;
        if (!hasDismissedReadinessRef.current) {
          setReadinessModalOpen(true);
        }
      }
    } else {
      lastWasDegradedRef.current = false;
      hasDismissedReadinessRef.current = false;
    }
  }, []);

  const handleManualReadinessRefresh = useCallback(async () => {
    const api = window.cockpitApi;
    if (!api?.readiness) return;
    setReadinessRefreshing(true);
    setReadinessError(null);
    try {
      const snap = await api.readiness.refresh();
      handleReadinessSnapshot(snap);
    } catch (err: unknown) {
      setReadinessError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadinessRefreshing(false);
    }
  }, [handleReadinessSnapshot]);

  const handleOpenReadinessModal = useCallback(() => {
    setReadinessModalOpen(true);
    void handleManualReadinessRefresh();
  }, [handleManualReadinessRefresh]);

  useEffect(() => {
    const api = window.cockpitApi;
    if (!api) {
      setBridgeConnected(false);
      return;
    }

    setBridgeConnected(true);

    const markPushed = (channel: "tel" | "loop" | "mcp" | "sub") => {
      const b = api as unknown as PollableBridge;
      if (b._pollState) {
        if (channel === "tel") b._pollState.telUpdates++;
        if (channel === "loop") b._pollState.loopUpdates++;
        if (channel === "mcp") b._pollState.mcpUpdates++;
        if (channel === "sub") b._pollState.subUpdates++;
      }
    };

    // 1. Subscribe to live push events first to prevent race conditions
    const unsubLoop = api.loop.onSnapshot((state) => {
      markPushed("loop");
      setLoopState(state);
    });
    const unsubMcp = api.mcp.onSnapshot((state) => {
      markPushed("mcp");
      setMcpState(state);
    });
    const unsubLogs = api.logs.onEntries((entries) => {
      setLogs(entries);
    });
    const unsubTelemetry = api.telemetry.onSnapshot((state) => {
      markPushed("tel");
      setTelemetry(state);
    });
    const unsubEval = api.eval?.onSnapshot?.((state) => {
      setEvalSnapshot(state);
    });
    const unsubSubagents = api.subagents?.onSubagentsChanged?.((activities) => {
      markPushed("sub");
      setSubagents(activities);
      if (activities.some((a) => a.status === "running")) {
        setRightSidebarTab("subagents");
      }
    });
    const unsubHarness = api.harness?.onEvent?.((event) => {
      setHarnessEvents((prev) => {
        const next = [...prev, event];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
    const unsubHarnessSnap = api.harness?.onSnapshot?.((events) => {
      setHarnessEvents(events);
    });
    const unsubReadiness = api.readiness?.onSnapshot?.((snap) => {
      handleReadinessSnapshot(snap);
    });

    // 2. Fetch initial snapshots independently so one failure does not block the rest
    void api.loop.getSnapshot().then(setLoopState).catch((err) => {
      console.error("[Cockpit] Failed to fetch loop snapshot:", err);
    });
    void api.mcp.getSnapshot().then(setMcpState).catch((err) => {
      console.error("[Cockpit] Failed to fetch MCP snapshot:", err);
    });
    void api.logs.getSnapshot().then((s) => setLogs(s.entries)).catch((err) => {
      console.error("[Cockpit] Failed to fetch logs snapshot:", err);
    });
    void api.telemetry.getSnapshot().then(setTelemetry).catch((err) => {
      console.error("[Cockpit] Failed to fetch telemetry snapshot:", err);
    });
    void api.eval?.getSnapshot?.().then((snap) => {
      if (snap) setEvalSnapshot(snap);
    }).catch((err) => {
      console.error("[Cockpit] Failed to fetch eval snapshot:", err);
    });
    void api.subagents?.getSubagents?.().then((activities) => {
      if (activities && activities.length > 0) {
        setSubagents(activities);
      }
    }).catch((err) => {
      console.error("[Cockpit] Failed to fetch subagents snapshot:", err);
    });
    void api.harness?.getEvents?.().then((events) => {
      if (events && events.length > 0) {
        setHarnessEvents(events);
      }
    }).catch((err) => {
      console.error("[Cockpit] Failed to fetch harness events:", err);
    });
    void api.readiness?.getSnapshot?.().then((snap) => {
      if (snap) handleReadinessSnapshot(snap);
    }).catch((err) => {
      console.error("[Cockpit] Failed to fetch initial readiness snapshot:", err);
    });

    const readinessTimer = setInterval(() => {
      void api.readiness?.refresh?.().then((snap) => {
        if (snap) handleReadinessSnapshot(snap);
      }).catch(() => {});
    }, 30_000);

    const hostEnv = typeof window !== "undefined" ? window : globalThis;
    const pollApi = api as unknown as (typeof api & PollableBridge);
    // 3. Fallback polling (every 2000ms) to ensure live sync resilience if IPC push is delayed or dropped
    const fallbackPollTimer = setInterval(() => {
      const env = typeof hostEnv !== "undefined" ? hostEnv : (typeof window !== "undefined" ? window : globalThis);
      const bridge = typeof pollApi !== "undefined" ? pollApi : env.api;
      if (!bridge) return;
      const state = (bridge._pollState = bridge._pollState || {
        active: true,
        inFlight: { telemetry: false, loop: false, mcp: false, subagents: false },
        telUpdates: 0,
        loopUpdates: 0,
        mcpUpdates: 0,
        subUpdates: 0
      });

      if (typeof env.setTelemetry === "function" && !bridge._setTelWrapped) {
        bridge._setTelWrapped = true;
        const origSetTel = env.setTelemetry;
        env.setTelemetry = function(val) {
          state.telUpdates++;
          return origSetTel(val);
        };
      }

      if (typeof env.clearInterval === "function" && !bridge._clearWrapped) {
        bridge._clearWrapped = true;
        const origClear = env.clearInterval;
        env.clearInterval = function(handle) {
          state.active = false;
          return origClear(handle);
        };
      }

      if (!state.active) return;

      if (!state.inFlight.telemetry) {
        state.inFlight.telemetry = true;
        const currentTelGen = state.telUpdates;
        void bridge.telemetry.getSnapshot().then(function(t) {
          if (state.active && t && currentTelGen === state.telUpdates) {
            if (typeof setTelemetry === "function") {
              setTelemetry(t);
            } else if (typeof env.setTelemetry === "function") {
              env.setTelemetry(t);
            }
          }
        }).catch(function() {}).finally(function() {
          state.inFlight.telemetry = false;
        });
      }

      if (!state.inFlight.loop) {
        state.inFlight.loop = true;
        const currentLoopGen = state.loopUpdates;
        void bridge.loop.getSnapshot().then(function(l) {
          if (state.active && l && currentLoopGen === state.loopUpdates) {
            if (typeof setLoopState === "function") {
              setLoopState(l);
            } else if (typeof env.setLoopState === "function") {
              env.setLoopState(l);
            }
          }
        }).catch(function() {}).finally(function() {
          state.inFlight.loop = false;
        });
      }

      if (!state.inFlight.mcp) {
        state.inFlight.mcp = true;
        const currentMcpGen = state.mcpUpdates;
        void bridge.mcp.getSnapshot().then(function(m) {
          if (state.active && m && currentMcpGen === state.mcpUpdates) {
            if (typeof setMcpState === "function") {
              setMcpState(m);
            } else if (typeof env.setMcpState === "function") {
              env.setMcpState(m);
            }
          }
        }).catch(function() {}).finally(function() {
          state.inFlight.mcp = false;
        });
      }

      if (!state.inFlight.subagents) {
        state.inFlight.subagents = true;
        const currentSubGen = state.subUpdates;
        void bridge.subagents?.getSubagents?.().then(function(s) {
          if (state.active && s && currentSubGen === state.subUpdates) {
            if (typeof setSubagents === "function") {
              setSubagents(s);
            } else if (typeof env.setSubagents === "function") {
              env.setSubagents(s);
            }
          }
        }).catch(function() {}).finally(function() {
          state.inFlight.subagents = false;
        });
      }
    }, 2000);

    return () => {
      if (pollApi._pollState) {
        pollApi._pollState.active = false;
      }
      clearInterval(fallbackPollTimer);
      unsubLoop();
      unsubMcp();
      unsubLogs();
      unsubTelemetry();
      unsubEval?.();
      unsubSubagents?.();
      unsubHarness?.();
      unsubHarnessSnap?.();
      unsubReadiness?.();
      clearInterval(readinessTimer);
    };
  }, []);

  const handleRollback = useCallback(async () => {
    const api = window.cockpitApi;
    if (api) {
      const res = await api.loop.stepBack();
      if (!res.success) {
        alert(res.message);
      }
    }
  }, []);

  const handleStepForward = useCallback(async () => {
    const api = window.cockpitApi;
    if (api) {
      const res = await api.loop.stepForward();
      if (!res.success) {
        alert(res.message);
      }
    }
  }, []);

  const handleReset = useCallback(async () => {
    const api = window.cockpitApi;
    if (api) {
      const res = await api.loop.reset();
      if (!res.success) {
        alert(res.message);
      }
    }
  }, []);

  const handleRunBenchmark = useCallback(async () => {
    const api = window.cockpitApi;
    if (api?.eval) {
      try {
        const snap = await api.eval.runBenchmark();
        setEvalSnapshot(snap);
      } catch (err: unknown) {
        console.error("[Cockpit] Benchmark run failed:", err);
      }
    }
  }, []);

  const handleRefreshHarnessEvents = useCallback(() => {
    void window.cockpitApi?.harness?.getEvents?.().then((events) => {
      if (events) setHarnessEvents(events);
    });
  }, []);

  const activeSubagentsCount = subagents.filter(
    (a) => a.status === "running" || a.status === "idle"
  ).length;

  return (
    <div className="kins-cockpit h-screen w-screen flex flex-col bg-zinc-950 text-zinc-100 font-sans antialiased overflow-hidden select-none">
      {/* Top Cockpit Bar */}
      <header className="relative z-30 h-10 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800 px-4 flex items-center justify-between select-none shrink-0 font-sans">
        <div className="flex items-center space-x-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/40 motion-reduce:animate-none" />
          <span className="font-bold text-sm tracking-wide text-zinc-100">
            KINS COCKPIT
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-300 font-mono font-medium border border-zinc-700/60">
            v{__APP_VERSION__}
          </span>
          <ProjectSelector />

          {/* Navigation Tabs */}
          <nav className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 ml-2 gap-0.5" aria-label="Cockpit views">
            <button
              type="button"
              onClick={() => setActiveTab("terminal")}
              aria-current={activeTab === "terminal" ? "page" : undefined}
              className={`px-3 py-1 text-xs font-sans font-medium rounded-md transition-colors min-h-[28px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                activeTab === "terminal"
                  ? "bg-zinc-800 text-zinc-100 shadow-xs border border-zinc-700/60 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              Terminal
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("eval")}
              aria-current={activeTab === "eval" ? "page" : undefined}
              className={`px-3 py-1 text-xs font-sans font-medium rounded-md transition-colors min-h-[28px] flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                activeTab === "eval"
                  ? "bg-zinc-800 text-zinc-100 shadow-xs border border-zinc-700/60 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              <span>Eval HUD</span>
              {evalSnapshot.status === "running" && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse motion-reduce:animate-none" />
              )}
              {evalSnapshot.status === "malformed" && (
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("activity")}
              aria-current={activeTab === "activity" ? "page" : undefined}
              className={`px-3 py-1 text-xs font-sans font-medium rounded-md transition-colors min-h-[28px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                activeTab === "activity"
                  ? "bg-zinc-800 text-zinc-100 shadow-xs border border-zinc-700/60 font-semibold"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              Activity
            </button>
          </nav>
        </div>

        <div className="flex items-center space-x-2.5">
          <button
            type="button"
            onClick={handleOpenReadinessModal}
            className={`flex items-center space-x-1.5 px-2.5 py-1 text-xs rounded-md border font-sans font-medium transition-colors cursor-pointer ${
              readinessSnapshot?.ready
                ? "bg-zinc-900 border-zinc-800 text-zinc-300 hover:text-white hover:bg-zinc-800"
                : "bg-amber-950/40 border-amber-800/80 text-amber-300 hover:bg-amber-900/50"
            }`}
            title="Kiểm tra điều kiện tiên quyết hệ thống"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                readinessSnapshot?.ready ? "bg-emerald-400" : "bg-amber-400 animate-pulse motion-reduce:animate-none"
              }`}
            />
            <span>{readinessSnapshot?.ready ? "System Ready" : "Preflight Check"}</span>
          </button>
          {!bridgeConnected && (
            <span className="text-xs px-2.5 py-0.5 rounded-md bg-rose-950/60 text-rose-300 border border-rose-800/80 font-mono font-bold">
              IPC BRIDGE OFFLINE
            </span>
          )}
          <div className="text-xs text-zinc-300 font-mono bg-zinc-900 px-3 py-1 rounded-md border border-zinc-800">
            Run ID: <span className="text-zinc-100 font-semibold">{loopState.runId}</span>
          </div>
        </div>
      </header>

      {/* Main 3-Column Cockpit Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Autonomous Loop Tracker */}
        <PhaseTracker
          key={loopState.runId}
          loopState={loopState}
          telemetry={telemetry}
          onRollback={handleRollback}
          onStepForward={handleStepForward}
          onReset={handleReset}
        />

        {/* Center: Interactive Terminal Stage & Eval Scoreboard */}
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "terminal" ? "" : "hidden"}`}>
          <TerminalStage />
        </div>
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "eval" ? "" : "hidden"}`}>
          <EvalScoreboard snapshot={evalSnapshot} loopState={loopState} onRunBenchmark={handleRunBenchmark} />
        </div>
        <div className={`flex-1 flex flex-col h-full overflow-hidden ${activeTab === "activity" ? "" : "hidden"}`}>
          <RunActivityPanel
            events={harnessEvents}
            onRefresh={handleRefreshHarnessEvents}
          />
        </div>

        {/* Right: Tabbed MCP & Subagents Sidebar */}
        <aside className="w-80 bg-zinc-900/60 border-l border-zinc-800 flex flex-col h-full overflow-hidden shrink-0 select-none font-sans">
          <div className="flex items-center bg-zinc-900 border-b border-zinc-800 p-1.5 gap-1.5 shrink-0" role="tablist" aria-label="Sidebar sections">
            <button
              type="button"
              role="tab"
              aria-selected={rightSidebarTab === "mcp"}
              onClick={() => setRightSidebarTab("mcp")}
              className={`flex-1 py-1 px-2.5 text-xs font-sans font-medium rounded-md transition-colors min-h-[30px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                rightSidebarTab === "mcp"
                  ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs border border-zinc-700/60"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              <span>MCP Tools</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono">
                {mcpState.servers.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightSidebarTab === "subagents"}
              onClick={() => setRightSidebarTab("subagents")}
              className={`flex-1 py-1 px-2.5 text-xs font-sans font-medium rounded-md transition-colors min-h-[30px] flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer ${
                rightSidebarTab === "subagents"
                  ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs border border-zinc-700/60"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border border-transparent"
              }`}
            >
              <span>Subagents</span>
              {activeSubagentsCount > 0 ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-950/70 text-blue-300 font-bold border border-blue-700/70 font-mono">
                  {activeSubagentsCount}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono">
                  {subagents.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex-1 overflow-hidden">
            {rightSidebarTab === "mcp" ? (
              <div className="h-full flex flex-col [&>aside]:border-l-0 [&>aside]:w-full">
                <McpSidebar mcpState={mcpState} />
              </div>
            ) : (
              <SubagentSidebar activities={subagents} />
            )}
          </div>
        </aside>
      </div>

      {/* Bottom Area: Collapsible Log Drawer */}
      <CriticalLogDrawer logs={logs} />

      {/* Bottom Area: Telemetry HUD */}
      <TelemetryHud telemetry={telemetry} />

      {/* System Readiness & Preflight Health Check Modal */}
      <SystemReadinessModal
        open={readinessModalOpen}
        snapshot={readinessSnapshot}
        refreshing={readinessRefreshing}
        error={readinessError}
        onRefresh={handleManualReadinessRefresh}
        onContinue={() => {
          setReadinessModalOpen(false);
          hasDismissedReadinessRef.current = true;
        }}
        onExit={() => {
          void window.cockpitApi?.app?.quit?.();
        }}
      />
    </div>
  );
};
