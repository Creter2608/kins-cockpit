import React, { type ErrorInfo, type ReactNode } from "react";
import { AlertOctagon, RotateCw } from "lucide-react";

export interface CockpitErrorBoundaryProps {
  children: ReactNode;
}

interface CockpitErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class CockpitErrorBoundary extends React.Component<
  CockpitErrorBoundaryProps,
  CockpitErrorBoundaryState
> {
  constructor(props: CockpitErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): CockpitErrorBoundaryState {
    return {
      hasError: true,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[CockpitErrorBoundary] Uncaught React render error:", error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 p-8 font-sans select-none">
          <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-2xl flex flex-col items-center text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-rose-950/80 border border-rose-800/80 flex items-center justify-center text-rose-400">
              <AlertOctagon className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-bold text-zinc-100">
              Cockpit UI Render Incident
            </h2>
            <p className="text-xs text-zinc-400">
              A component encountered an unhandled rendering error. The underlying PTY and background services remain active.
            </p>
            {this.state.error && (
              <div className="w-full p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-left overflow-auto max-h-36">
                <code className="text-xs font-mono text-rose-300 break-words">
                  {this.state.error.message}
                </code>
              </div>
            )}
            <div className="flex items-center space-x-3 w-full pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="flex-1 min-h-[36px] px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs font-semibold text-zinc-200 transition-colors flex items-center justify-center space-x-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Recover Component</span>
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="flex-1 min-h-[36px] px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-semibold text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                Reload Window
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}