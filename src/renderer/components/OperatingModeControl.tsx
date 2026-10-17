import React, { useEffect, useState, useCallback, useRef } from "react";
import type {
  OperatingMode,
  OperatingModeSnapshot
} from "../../shared/operatingMode.js";
import { OPERATING_MODE_LABELS } from "../../shared/operatingMode.js";

const MODE_CONFIG: Record<
  OperatingMode,
  { label: string; icon: string; tooltip: string; activeClass: string; badgeClass: string }
> = {
  discussion: {
    label: OPERATING_MODE_LABELS.discussion,
    icon: "💬",
    tooltip: "Thảo luận (Read-only): Trò chuyện và phân tích code an toàn tuyệt đối. Cấm sửa file.",
    activeClass: "bg-cyan-950/80 text-cyan-200 border-cyan-700/70 shadow-xs",
    badgeClass: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40"
  },
  tweak: {
    label: OPERATING_MODE_LABELS.tweak,
    icon: "⚡",
    tooltip: "Tinh chỉnh (Sửa nhanh $0): Bounded mutation (≤3 files, ≤120 dòng). Bỏ qua Oracle.",
    activeClass: "bg-amber-950/80 text-amber-200 border-amber-700/70 shadow-xs",
    badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/40"
  },
  loop: {
    label: OPERATING_MODE_LABELS.loop,
    icon: "🔁",
    tooltip: "Loop (Tự trị 10 pha): Quy trình Autonomous Loop v3.0 đầy đủ với Blueprint & Audit Oracle.",
    activeClass: "bg-emerald-950/80 text-emerald-200 border-emerald-700/70 shadow-xs",
    badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
  }
};

export const OperatingModeControl: React.FC = () => {
  const [snapshot, setSnapshot] = useState<OperatingModeSnapshot | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const api = window.cockpitApi;
    if (!api?.operatingMode) return;

    let mounted = true;
    void api.operatingMode.getSnapshot().then((snap) => {
      if (mounted) setSnapshot(snap);
    }).catch(() => {});

    const unsubscribeMode = api.operatingMode.onModeChanged((updated) => {
      if (mounted) {
        setSnapshot(updated);
        setIsPending(false);
      }
    });

    const unsubscribeProject = api.project?.onProjectChanged?.((projState) => {
      if (mounted && projState.currentProject?.path) {
        void api.operatingMode?.getSnapshot(projState.currentProject.path).then((snap) => {
          if (mounted) setSnapshot(snap);
        }).catch(() => {});
      }
    });

    return () => {
      mounted = false;
      unsubscribeMode();
      unsubscribeProject?.();
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const handleSelectMode = useCallback(
    async (targetMode: OperatingMode) => {
      const api = window.cockpitApi;
      if (!api?.operatingMode || !snapshot || isPending || snapshot.mode === targetMode) {
        return;
      }

      setIsPending(true);
      setErrorMsg(null);
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = null;
      }

      try {
        const next = await api.operatingMode.setMode({
          workspaceId: snapshot.workspaceId,
          expectedRevision: snapshot.revision,
          mode: targetMode
        });
        setSnapshot(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setErrorMsg(message);
        errorTimeoutRef.current = setTimeout(() => {
          setErrorMsg(null);
          errorTimeoutRef.current = null;
        }, 4000);
      } finally {
        setIsPending(false);
      }
    },
    [snapshot, isPending]
  );

  const currentMode = snapshot?.mode ?? "loop";

  return (
    <div
      role="radiogroup"
      aria-label="Operating Mode Switch"
      className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 ml-2 gap-0.5"
    >
      {(["discussion", "tweak", "loop"] as const).map((mode) => {
        const cfg = MODE_CONFIG[mode];
        const isActive = currentMode === mode;

        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={isPending}
            title={cfg.tooltip}
            onClick={() => void handleSelectMode(mode)}
            className={`px-2.5 py-1 text-xs font-sans font-medium rounded-md transition-colors min-h-[28px] flex items-center space-x-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed border ${
              isActive
                ? `${cfg.activeClass} font-semibold`
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 border-transparent"
            }`}
          >
            <span>{cfg.icon}</span>
            <span>{cfg.label}</span>
          </button>
        );
      })}

      {errorMsg && (
        <span
          role="alert"
          className="text-xs text-rose-400 px-2 py-0.5 bg-rose-950/80 border border-rose-800 rounded"
          title={errorMsg}
        >
          {errorMsg}
        </span>
      )}
    </div>
  );
};
