/// <reference types="vite/client" />
import type { CockpitApi } from "../shared/contracts.js";

interface CockpitPollState {
  active: boolean;
  inFlight: {
    telemetry: boolean;
    loop: boolean;
    mcp: boolean;
    subagents: boolean;
  };
  telUpdates: number;
  loopUpdates: number;
  mcpUpdates: number;
  subUpdates: number;
}

interface PollableBridge {
  _pollState?: CockpitPollState;
  _setTelWrapped?: boolean;
  _clearWrapped?: boolean;
}

declare global {
  const __APP_VERSION__: string;
  /* eslint-disable no-var */
  var api: (CockpitApi & PollableBridge) | undefined;
  var setTelemetry: ((snapshot?: unknown) => void) | undefined;
  var setLoopState: ((snapshot?: unknown) => void) | undefined;
  var setMcpState: ((snapshot?: unknown) => void) | undefined;
  var setSubagents: ((snapshot?: unknown) => void) | undefined;
  /* eslint-enable no-var */
  interface Window {
    readonly cockpitApi?: CockpitApi;
    api?: CockpitApi & PollableBridge;
    setTelemetry?: (snapshot?: unknown) => void;
    setLoopState?: (snapshot?: unknown) => void;
    setMcpState?: (snapshot?: unknown) => void;
    setSubagents?: (snapshot?: unknown) => void;
  }
}

export type { CockpitPollState, PollableBridge };
