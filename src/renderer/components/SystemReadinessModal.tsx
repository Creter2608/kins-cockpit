/**
 * src/renderer/components/SystemReadinessModal.tsx
 * Accessible, Zinc-dark modal for system prerequisites and preflight diagnostics.
 * Adheres strictly to Impeccable Design Standards & UI/UX Pro Max guidelines.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Play,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Terminal,
  Copy,
  Check,
  RefreshCw,
  X,
  LogOut,
  ArrowRight,
  Cpu
} from "lucide-react";
import type { SystemReadinessSnapshot } from "../../shared/systemReadiness.js";

export interface SystemReadinessModalProps {
  open: boolean;
  snapshot: SystemReadinessSnapshot | null;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onContinue: () => void;
  onExit: () => void;
}

export const SystemReadinessModal: React.FC<SystemReadinessModalProps> = ({
  open,
  snapshot,
  refreshing,
  error,
  onRefresh,
  onContinue,
  onExit
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [launchedId, setLaunchedId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);

  const handleExecuteInTerminal = useCallback(async (id: string, cmd: string) => {
    if (executingId) return;
    setExecutingId(id);
    setLaunchError(null);
    setClipboardNotice(null);

    if (navigator?.clipboard?.writeText) {
      navigator.clipboard
        .writeText(cmd)
        .then(() => {
          setCopiedId(id);
          setTimeout(() => setCopiedId(null), 2500);
        })
        .catch(() => {
          setClipboardNotice("Clipboard write unavailable; proceeding with terminal launch.");
          setTimeout(() => setClipboardNotice(null), 3500);
        });
    } else {
      setClipboardNotice("Clipboard API unavailable; proceeding with terminal launch.");
      setTimeout(() => setClipboardNotice(null), 3500);
    }

    try {
      if (id !== "antigravity" && id !== "codegraph") {
        throw new Error("Unsupported prerequisite ID: " + id);
      }
      const launcher = window.cockpitApi?.readiness?.executeInTerminal;
      if (typeof launcher !== "function") {
        throw new Error("Terminal execution API is unavailable in this session.");
      }
      await launcher(id);
      setLaunchedId(id);
      setTimeout(() => setLaunchedId(null), 4000);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
      setTimeout(() => setLaunchError(null), 5000);
    } finally {
      setExecutingId(null);
    }
  }, [executingId]);
  const modalRef = useRef<HTMLDivElement>(null);
  const lastActiveElementRef = useRef<HTMLElement | null>(null);

  // 1. Focus management: Save previous active element & restore on close
  useEffect(() => {
    if (open) {
      lastActiveElementRef.current = document.activeElement as HTMLElement;
    } else if (lastActiveElementRef.current) {
      try {
        lastActiveElementRef.current.focus();
      } catch {
        // Ignore unattached elements
      }
    }
  }, [open]);

  // 2. Focus trap & Escape key listener
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onContinue();
        return;
      }

      if (event.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (first && last) {
          if (event.shiftKey) {
            if (document.activeElement === first) {
              event.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onContinue]);

  // 3. Auto-focus primary action upon opening
  useEffect(() => {
    if (open && modalRef.current) {
      const primaryBtn = modalRef.current.querySelector<HTMLElement>("[data-autofocus='true']");
      if (primaryBtn) {
        primaryBtn.focus();
      }
    }
  }, [open]);

  const handleCopyCommand = useCallback((id: string, cmd: string) => {
    if (!navigator.clipboard) return;
    navigator.clipboard
      .writeText(cmd)
      .then(() => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2500);
      })
      .catch((err) => {
        console.error("[SystemReadinessModal] Clipboard copy failed:", err);
      });
  }, []);

  if (!open) return null;

  const prerequisites = snapshot?.prerequisites ?? [];
  const hasChecking = refreshing || !snapshot;
  const hasMissing = prerequisites.some((i) => i.state === "missing" || i.state === "unavailable");
  const hasWarnings = prerequisites.some((i) => i.state === "outdated" || i.state === "stopped");
  const allReady = snapshot ? snapshot.ready : false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="readiness-modal-title"
      aria-describedby="readiness-modal-desc"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 font-sans select-none antialiased"
    >
      <div
        ref={modalRef}
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl shadow-black/90 flex flex-col max-h-[85vh] overflow-hidden text-zinc-100"
      >
        {/* Header */}
        <header className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/90 shrink-0">
          <div className="flex items-center space-x-2.5">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                hasChecking
                  ? "bg-amber-400 animate-pulse"
                  : allReady
                  ? "bg-emerald-500 shadow-xs shadow-emerald-500/40"
                  : hasMissing
                  ? "bg-rose-500"
                  : "bg-amber-400"
              }`}
            />
            <div className="flex items-center space-x-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <h2 id="readiness-modal-title" className="text-sm font-bold tracking-wide uppercase text-zinc-100">
                System Readiness &amp; Preflight Health Check
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onContinue}
            aria-label="Close system readiness check dialog"
            className="text-zinc-400 hover:text-zinc-100 p-1.5 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer min-h-[32px] min-w-[32px] flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Status Announcement Banner (ARIA Live) */}
        <div
          id="readiness-modal-desc"
          aria-live="polite"
          className="px-5 py-2.5 bg-zinc-950/70 border-b border-zinc-800 text-xs font-mono flex items-center justify-between shrink-0"
        >
          <span className="text-zinc-400">
            {refreshing
              ? "Scanning execution environment and background daemon processes..."
              : error
              ? `System preflight check error: ${error}`
              : allReady
              ? "All prerequisites satisfied. Cockpit operating in optimal state."
              : hasMissing
              ? "Missing prerequisite detected. You can copy the remediation command below."
              : "Environment warning detected. Cockpit may operate in Restricted Mode."}
          </span>
          <span className="text-[11px] px-2 py-0.5 rounded font-bold font-mono bg-zinc-800 border border-zinc-700 text-zinc-300">
            {prerequisites.filter((i) => i.state === "ready").length}/{prerequisites.length || 6} Ready
          </span>
        </div>

        {/* Prerequisite Rows List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3 custom-scrollbar bg-zinc-950/40">
          {prerequisites.map((item) => (
            <div
              key={item.id}
              className={`p-3.5 rounded-lg border transition-colors ${
                item.state === "ready"
                  ? "bg-zinc-900/90 border-zinc-800/90 hover:border-zinc-700"
                  : item.state === "outdated" || item.state === "stopped"
                  ? "bg-amber-950/20 border-amber-800/60"
                  : "bg-rose-950/20 border-rose-800/60"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2.5 min-w-0">
                  {item.state === "ready" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : item.state === "outdated" || item.state === "stopped" ? (
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  )}
                  <span className="text-xs font-semibold text-zinc-200 uppercase tracking-wide">
                    {item.id === "git"
                      ? "Git Version Control"
                      : item.id === "node"
                      ? "Node.js Runtime"
                      : item.id === "docker"
                      ? "Docker Sandbox Container"
                      : item.id === "openai"
                      ? "GPT Oracle (OpenAI)"
                      : item.id === "codegraph"
                      ? "CodeGraph AST Engine"
                      : "Antigravity CLI"}
                  </span>
                  {item.version && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-zinc-800 text-cyan-300 border border-zinc-700">
                      {item.version}
                    </span>
                  )}
                  {item.maskedPreview && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-zinc-800 text-emerald-300 border border-zinc-700">
                      {item.maskedPreview}
                    </span>
                  )}
                </div>

                <span
                  className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold border ${
                    item.state === "ready"
                      ? "bg-emerald-950/60 text-emerald-400 border-emerald-800/80"
                      : item.state === "outdated" || item.state === "stopped"
                      ? "bg-amber-950/60 text-amber-400 border-amber-800/80"
                      : "bg-rose-950/60 text-rose-400 border-rose-800/80"
                  }`}
                >
                  {item.state}
                </span>
              </div>

              <p className="text-[11px] text-zinc-400 leading-relaxed font-sans mt-1.5">
                {item.detail}
              </p>

              {/* 1-Click Copyable Command & Terminal Launch Button */}
              {item.copyCommand && (
                <div className="mt-2.5 flex flex-col space-y-1.5">
                  <div className="flex items-center space-x-2 bg-zinc-950 border border-zinc-800 rounded p-1.5 font-mono text-[11px]">
                    <Terminal className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                    <code className="text-zinc-200 flex-1 truncate select-all">{item.copyCommand}</code>

                    {(item.id === "antigravity" || item.id === "codegraph") && (
                      <button
                        type="button"
                        onClick={() => handleExecuteInTerminal(item.id, item.copyCommand!)}
                        disabled={executingId === item.id}
                        title="Open interactive terminal and execute command"
                        aria-label={`Run installation for ${item.id} in terminal`}
                        className="px-2 py-1 bg-cyan-950/70 hover:bg-cyan-900/80 border border-cyan-800/80 text-cyan-200 rounded text-[11px] font-sans font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 cursor-pointer flex items-center space-x-1 shrink-0 disabled:opacity-50"
                      >
                        {executingId === item.id ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                            <span>Opening...</span>
                          </>
                        ) : launchedId === item.id ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-400" />
                            <span className="text-emerald-300">Opened!</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3 h-3 text-cyan-400 fill-cyan-400/20" />
                            <span>Run in PowerShell</span>
                          </>
                        )}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleCopyCommand(item.id, item.copyCommand!)}
                      title="Copy command"
                      aria-label={`Copy installation command for ${item.id}`}
                      className="p-1 text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer min-h-[28px] min-w-[28px] flex items-center justify-center shrink-0"
                    >
                      {copiedId === item.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                  {clipboardNotice && (
                    <p className="text-[10px] text-amber-400/90 font-sans pl-1">
                      {clipboardNotice}
                    </p>
                  )}
                  {launchError && (
                    <p className="text-[10px] text-rose-400 font-sans pl-1">
                      Failed to launch terminal: {launchError}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer Actions */}
        <footer className="px-5 py-3 border-t border-zinc-800 bg-zinc-900/90 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onExit}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-rose-300 hover:text-rose-100 bg-zinc-900 hover:bg-rose-950/50 border border-zinc-800 hover:border-rose-800/80 transition-colors flex items-center space-x-1.5 cursor-pointer min-h-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Exit Application</span>
          </button>

          <div className="flex items-center space-x-2.5">
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/80 transition-colors flex items-center space-x-1.5 disabled:opacity-50 cursor-pointer min-h-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-cyan-400" : ""}`} />
              <span>Refresh</span>
            </button>

            <button
              type="button"
              data-autofocus="true"
              onClick={onContinue}
              disabled={refreshing}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer min-h-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${
                allReady
                  ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-950"
                  : "bg-cyan-600 hover:bg-cyan-500 text-white shadow-sm shadow-cyan-950"
              }`}
            >
              <span>{allReady ? "Continue to Cockpit" : "Continue (Restricted Mode)"}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
