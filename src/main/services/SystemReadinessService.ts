/**
 * src/main/services/SystemReadinessService.ts
 * Asynchronously probes local environment prerequisites:
 * 1. Git (version control)
 * 2. Node.js (>= 22 engine requirement)
 * 3. Docker (kins_autonomous_sandbox container)
 * 4. Antigravity CLI (agy / antigravity with Windows candidate paths)
 * 5. GPT Oracle (OPENAI_API_KEY with Zero-Exposure presence check & masking)
 * 6. CodeGraph (AST semantic index and structural code navigation engine)
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { DockerStatusService } from "./DockerStatusService.js";
import type { DockerSandboxStatus } from "../../shared/contracts.js";
import type { PrerequisiteReadiness, SystemReadinessSnapshot } from "../../shared/systemReadiness.js";
import { maskCredential, extractOpenAiKeyFromMcpJson } from "./credentialMasker.js";

const defaultExecFileAsync = promisify(execFile);

const defaultExecFileWrapper = async (
  file: string,
  args: readonly string[],
  options?: unknown
): Promise<{ stdout: string; stderr: string }> => {
  let execTarget = file;
  let execArgs = [...args];
  const execOptions = ((options as ExecFileOptions) ?? {}) as ExecFileOptions;

  if (
    process.platform === "win32" &&
    (file.toLowerCase().endsWith(".cmd") || file.toLowerCase().endsWith(".bat"))
  ) {
    if (!syncFs.existsSync(file)) {
      const err = new Error(`spawn ${file} ENOENT`);
      (err as { code?: string }).code = "ENOENT";
      throw err;
    }
    const comSpec = process.env.ComSpec || "cmd.exe";
    execTarget = comSpec;
    execArgs = ["/d", "/c", "call", file, ...args];
  }

  const res = await defaultExecFileAsync(execTarget, execArgs, execOptions);
  return { stdout: String(res.stdout), stderr: String(res.stderr) };
};

export interface SystemReadinessServiceOptions {
  readonly execFileFn?: (
    file: string,
    args: readonly string[],
    options?: unknown
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly homedir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readFileFn?: (filePath: string) => Promise<string>;
  readonly platform?: NodeJS.Platform;
}

export class SystemReadinessService {
  private readonly listeners = new Set<(snapshot: SystemReadinessSnapshot) => void>();
  private readonly execFile: (
    file: string,
    args: readonly string[],
    options?: unknown
  ) => Promise<{ stdout: string; stderr: string }>;
  private readonly homedir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;

  private lastSnapshot: SystemReadinessSnapshot | null = null;
  private inFlightRefresh: Promise<SystemReadinessSnapshot> | null = null;
  private dockerUnsubscribe: (() => void) | null = null;
  private isDisposed = false;

  constructor(
    private readonly dockerStatusService: DockerStatusService,
    options?: SystemReadinessServiceOptions
  ) {
    this.execFile = options?.execFileFn ?? defaultExecFileWrapper;
    this.homedir = options?.homedir ?? os.homedir();
    this.env = options?.env ?? process.env;
    this.readFile = options?.readFileFn ?? ((p: string) => fs.readFile(p, "utf-8"));
    this.platform = options?.platform ?? process.platform;

    this.dockerUnsubscribe = this.dockerStatusService.subscribe((dockerStatus) => {
      if (this.isDisposed || !this.lastSnapshot) return;
      this.handleDockerStatusUpdate(dockerStatus);
    });
  }

  private handleDockerStatusUpdate(dockerStatus: DockerSandboxStatus): void {
    if (!this.lastSnapshot) return;

    const dockerPrereq = this.mapDockerStatusToPrerequisite(dockerStatus);
    const updatedPrereqs = this.lastSnapshot.prerequisites.map((p) =>
      p.id === "docker" ? dockerPrereq : p
    );
    const ready = updatedPrereqs.every((p) => p.state === "ready");

    const newSnapshot: SystemReadinessSnapshot = {
      checkedAt: Date.now(),
      prerequisites: Object.freeze(updatedPrereqs),
      ready
    };

    this.lastSnapshot = newSnapshot;
    this.emit(newSnapshot);
  }

  async refresh(): Promise<SystemReadinessSnapshot> {
    if (this.isDisposed) {
      return (
        this.lastSnapshot ?? {
          checkedAt: Date.now(),
          prerequisites: Object.freeze([]),
          ready: false
        }
      );
    }

    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = this.executeRefresh().finally(() => {
      this.inFlightRefresh = null;
    });

    return this.inFlightRefresh;
  }

  private async executeRefresh(): Promise<SystemReadinessSnapshot> {
    const [git, node, docker, antigravity, openai, codegraph] = await Promise.all([
      this.probeGit(),
      this.probeNode(),
      this.probeDocker(),
      this.probeAntigravity(),
      this.probeOpenAi(),
      this.probeCodeGraph()
    ]);

    const prerequisites = Object.freeze([git, node, docker, antigravity, openai, codegraph]);
    const ready = prerequisites.every((p) => p.state === "ready");

    const snapshot: SystemReadinessSnapshot = {
      checkedAt: Date.now(),
      prerequisites,
      ready
    };

    this.lastSnapshot = snapshot;
    this.emit(snapshot);
    return snapshot;
  }

  private async probeGit(): Promise<PrerequisiteReadiness> {
    try {
      const { stdout } = await this.execFile("git", ["--version"], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024
      });
      const output = stdout.trim();
      const match = output.match(/git version\s+([0-9.]+)/i);
      const version = match ? match[1] : output;
      return {
        id: "git",
        state: "ready",
        version: `git ${version}`,
        detail: "Git version control detected and available in system PATH."
      };
    } catch {
      return {
        id: "git",
        state: "missing",
        detail: "Git binary not found in PATH. Required for version control and worktree isolation.",
        copyCommand: "winget install --id Git.Git -e --source winget"
      };
    }
  }

  private async probeNode(): Promise<PrerequisiteReadiness> {
    try {
      const { stdout } = await this.execFile("node", ["--version"], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024
      });
      const output = stdout.trim();
      const match = output.match(/v?([0-9]+)\.([0-9]+)\.([0-9]+)/);
      const majorStr = match?.[1];
      const minorStr = match?.[2];
      const patchStr = match?.[3];

      if (!match || !majorStr || !minorStr || !patchStr) {
        return {
          id: "node",
          state: "unavailable",
          detail: `Node.js returned unrecognized version string: '${output}'.`,
          copyCommand: "winget install --id OpenJS.NodeJS.LTS -e"
        };
      }

      const major = parseInt(majorStr, 10);
      const version = `v${majorStr}.${minorStr}.${patchStr}`;

      if (major >= 22) {
        return {
          id: "node",
          state: "ready",
          version,
          detail: "Node.js runtime meets engine requirement (>= 22.0.0)."
        };
      } else {
        return {
          id: "node",
          state: "outdated",
          version,
          detail: `Node.js version ${version} is outdated. Cockpit runtime requires Node.js >= 22.0.0.`,
          copyCommand: "winget install --id OpenJS.NodeJS.LTS -e"
        };
      }
    } catch {
      return {
        id: "node",
        state: "missing",
        detail: "External Node.js runtime not found in PATH. Required for executing autonomous loop tasks.",
        copyCommand: "winget install --id OpenJS.NodeJS.LTS -e"
      };
    }
  }

  private async probeDocker(): Promise<PrerequisiteReadiness> {
    try {
      const status = await this.dockerStatusService.checkStatus();
      return this.mapDockerStatusToPrerequisite(status);
    } catch {
      return {
        id: "docker",
        state: "unavailable",
        detail: "Docker daemon socket or named pipe unavailable. Launch Docker Desktop, wait for daemon to become ready, then retry.",
        copyCommand: "winget install Docker.DockerDesktop -e"
      };
    }
  }

  private mapDockerStatusToPrerequisite(status: DockerSandboxStatus): PrerequisiteReadiness {
    switch (status) {
      case "Active":
        return {
          id: "docker",
          state: "ready",
          version: "Container Active",
          detail: "Docker sandbox container 'kins_autonomous_sandbox' is running and responsive."
        };
      case "Stopped":
        return {
          id: "docker",
          state: "stopped",
          version: "Container Stopped",
          detail: "Docker daemon is running, but sandbox container 'kins_autonomous_sandbox' is stopped.",
          copyCommand: "docker start kins_autonomous_sandbox"
        };
      case "Missing":
        return {
          id: "docker",
          state: "missing",
          version: "Container Missing",
          detail: "Docker sandbox container 'kins_autonomous_sandbox' does not exist.",
          copyCommand:
            'docker run -d --name kins_autonomous_sandbox -v "${PWD}:/workspace" -w /workspace node:22-bookworm-slim tail -f /dev/null'
        };
      case "Unavailable":
      default:
        return {
          id: "docker",
          state: "unavailable",
          version: "Daemon Offline",
          detail: "Docker Desktop daemon is offline or not installed. Launch Docker Desktop (or install with winget install Docker.DockerDesktop -e), wait for daemon, then retry.",
          copyCommand: "winget install Docker.DockerDesktop -e"
        };
    }
  }

  private async probeAntigravity(): Promise<PrerequisiteReadiness> {
    // 1. Candidate command names to probe via PATH
    const candidates = ["agy", "antigravity"];

    // 2. Candidate executable file paths on Windows if PATH fails
    if (this.platform === "win32") {
      const localAppData =
        this.env.LOCALAPPDATA || path.join(this.homedir, "AppData", "Local");
      candidates.push(
        path.join(localAppData, "agy", "bin", "agy.exe"),
        path.join(this.homedir, ".gemini", "antigravity-cli", "bin", "agy.exe")
      );
    }

    for (const candidate of candidates) {
      try {
        const { stdout } = await this.execFile(candidate, ["--version"], {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 64 * 1024
        });
        const output = stdout.trim();
        if (output.length > 0) {
          return {
            id: "antigravity",
            state: "ready",
            version: output.toLowerCase().includes("agy") || output.toLowerCase().includes("antigravity")
              ? output
              : `agy ${output}`,
            detail: "Antigravity CLI is installed and responsive."
          };
        }
      } catch {
        // Continue trying next candidate
      }
    }

    return {
      id: "antigravity",
      state: "missing",
      detail:
        "Antigravity CLI (agy) not found in PATH or standard install locations (%LOCALAPPDATA%\\agy\\bin). Install agy binary and add to PATH."
    };
  }

  private async probeOpenAi(): Promise<PrerequisiteReadiness> {
    const copyInstruction =
      "$k = Read-Host 'OPENAI_API_KEY' -AsSecureString; [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', [System.Net.NetworkCredential]::new('', $k).Password, 'User'); Remove-Variable k";

    // 1. First inspect non-blank environment variable
    const envKey = this.env.OPENAI_API_KEY?.trim();
    if (envKey && envKey.length > 0) {
      return {
        id: "openai",
        state: "ready",
        detail: "GPT Oracle API credential detected via OPENAI_API_KEY environment variable (Zero-Exposure).",
        maskedPreview: maskCredential(envKey)
      };
    }

    // 2. Otherwise safely inspect ~/.gemini/config/mcp_config.json
    const mcpConfigPath = path.join(this.homedir, ".gemini", "config", "mcp_config.json");
    let rawConfig: string;
    try {
      rawConfig = await this.readFile(mcpConfigPath);
    } catch {
      // Config file does not exist or unreadable
      return {
        id: "openai",
        state: "missing",
        detail: "GPT Oracle API key not configured. Stage 2 Blueprint and Stage 4 Audit require OPENAI_API_KEY.",
        copyCommand: copyInstruction
      };
    }

    const { key, error } = extractOpenAiKeyFromMcpJson(rawConfig);
    if (error === "malformed") {
      return {
        id: "openai",
        state: "unavailable",
        detail: "Malformed ~/.gemini/config/mcp_config.json. Unable to parse MCP configuration.",
        copyCommand: copyInstruction
      };
    }
    if (error === "conflicting") {
      return {
        id: "openai",
        state: "unavailable",
        detail:
          "Conflicting OPENAI_API_KEY credentials configured across MCP servers. Set a single unambiguous environment variable.",
        copyCommand: copyInstruction
      };
    }
    if (!key) {
      return {
        id: "openai",
        state: "missing",
        detail: "No OPENAI_API_KEY found in environment or ~/.gemini/config/mcp_config.json.",
        copyCommand: copyInstruction
      };
    }

    return {
      id: "openai",
      state: "ready",
      detail: "GPT Oracle API credential detected via MCP server configuration (Zero-Exposure).",
      maskedPreview: maskCredential(key)
    };
  }

  private async probeCodeGraph(): Promise<PrerequisiteReadiness> {
    const candidates: string[] = ["codegraph"];

    if (this.platform === "win32") {
      const localAppData =
        this.env.LOCALAPPDATA || `${this.homedir}\\AppData\\Local`;
      candidates.push(
        `${localAppData}\\codegraph\\current\\bin\\codegraph.cmd`,
        `${localAppData}\\codegraph\\current\\bin\\codegraph.exe`
      );
    }

    let executionFailedOrUnusable = false;

    for (const candidate of candidates) {
      try {
        const { stdout } = await this.execFile(candidate, ["--version"], {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 64 * 1024
        });
        const output = stdout.trim();
        if (output.length > 0) {
          const match = output.match(/(?:v)?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
          const verNum = match?.[1] ?? output;
          const version = output.startsWith("v") ? (verNum.startsWith("v") ? verNum : `v${verNum}`) : verNum;
          return {
            id: "codegraph",
            state: "ready",
            version: version.toLowerCase().includes("codegraph") ? version : `codegraph ${version}`,
            detail: "CodeGraph AST semantic index engine is installed and responsive."
          };
        } else {
          executionFailedOrUnusable = true;
        }
      } catch (err: unknown) {
        const code = (err as { code?: string | number } | null | undefined)?.code;
        if (code !== "ENOENT") {
          executionFailedOrUnusable = true;
        }
      }
    }

    if (executionFailedOrUnusable) {
      return {
        id: "codegraph",
        state: "unavailable",
        detail: "CodeGraph execution failed or returned invalid version output. Reinstall from GitHub releases or check permissions."
      };
    }

    return {
      id: "codegraph",
      state: "missing",
      detail:
        "CodeGraph CLI not found in PATH or %LOCALAPPDATA%\\codegraph\\current\\bin. Download from GitHub releases or clone repository."
    };
  }

  subscribe(listener: (snapshot: SystemReadinessSnapshot) => void): () => void {
    if (this.isDisposed) {
      return () => {};
    }
    this.listeners.add(listener);
    if (this.lastSnapshot) {
      listener(this.lastSnapshot);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(snapshot: SystemReadinessSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[SystemReadinessService] Listener error:", err);
      }
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    if (this.dockerUnsubscribe) {
      this.dockerUnsubscribe();
      this.dockerUnsubscribe = null;
    }
    this.listeners.clear();
  }
}
