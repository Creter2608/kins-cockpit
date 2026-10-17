import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { McpSnapshot, McpServerInfo, ToolCallRecord } from "../../shared/contracts.js";

export const PROJECT_MCP_CONFIG_PATHS = [
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".mcp.json",
] as const;


export class McpMonitorService {
  private projectRoot: string;
  private globalMcpDirs: string[];
  private servers: Map<string, McpServerInfo> = new Map();
  private recentCalls: ToolCallRecord[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(snapshot: McpSnapshot) => void>();

  constructor(
    projectRoot: string = process.cwd(),
    globalMcpDirs?: string[]
  ) {
    this.projectRoot = projectRoot;
    if (globalMcpDirs) {
      this.globalMcpDirs = globalMcpDirs;
    } else {
      const rawHome = process.env.USERPROFILE || process.env.HOME || "";
      const validHome = (rawHome && rawHome !== "undefined" && rawHome !== "null") ? path.resolve(rawHome) : null;
      const defaultDirs: string[] = [
        (process.resourcesPath
          ? path.join(process.resourcesPath, "bundled", "mcp-schemas")
          : path.join(process.cwd(), "resources", "bundled", "mcp-schemas"))
      ];
      if (validHome) {
        defaultDirs.push(
          path.join(validHome, ".gemini", "antigravity", "mcp"),
          path.join(validHome, ".gemini", "antigravity-cli", "mcp")
        );
      }
      this.globalMcpDirs = defaultDirs;
    }
    this.refresh();
  }

  /**
   * Auto-provisions bundled MCP schemas (codegraph, gpt_architect, kins-agent-loop)
   * into global Antigravity MCP tool directories (~/.gemini/antigravity-cli/mcp)
   * so non-author or freshly cloned environments discover all tools immediately.
   */
  public provisionBundledSchemas(): void {
    const packagedDir = (process as unknown as { resourcesPath?: string }).resourcesPath
      ? path.join((process as unknown as { resourcesPath: string }).resourcesPath, "bundled", "mcp-schemas")
      : null;
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const repoDir = this.projectRoot ? path.join(this.projectRoot, "resources", "bundled", "mcp-schemas") : null;
    const appBundledDirDist = path.resolve(currentDir, "..", "..", "..", "..", "resources", "bundled", "mcp-schemas");
    const appBundledDirSrc = path.resolve(currentDir, "..", "..", "..", "resources", "bundled", "mcp-schemas");

    let bundledSchemasDir: string | null = null;
    if (packagedDir && fs.existsSync(packagedDir)) {
      bundledSchemasDir = packagedDir;
    } else if (repoDir && fs.existsSync(repoDir)) {
      bundledSchemasDir = repoDir;
    } else if (fs.existsSync(appBundledDirDist)) {
      bundledSchemasDir = appBundledDirDist;
    } else if (fs.existsSync(appBundledDirSrc)) {
      bundledSchemasDir = appBundledDirSrc;
    }

    if (!bundledSchemasDir) {
      return;
    }

    const rawHome = process.env.USERPROFILE || process.env.HOME || "";
    if (!rawHome || rawHome === "undefined" || rawHome === "null") return;
    const home = path.resolve(rawHome);

    const targetDirs = [
      path.join(home, ".gemini", "antigravity-cli", "mcp"),
      path.join(home, ".gemini", "antigravity", "mcp")
    ];

    try {
      const serverEntries = fs.readdirSync(bundledSchemasDir, { withFileTypes: true });
      for (const targetBase of targetDirs) {
        for (const entry of serverEntries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.includes("..") || path.basename(entry.name) !== entry.name) continue;

          const srcServerDir = path.join(bundledSchemasDir, entry.name);
          const dstServerDir = path.join(targetBase, entry.name);

          try {
            if (!fs.existsSync(dstServerDir)) {
              fs.mkdirSync(dstServerDir, { recursive: true });
            }
            const files = fs.readdirSync(srcServerDir);
            for (const file of files) {
              if (file.includes("..") || path.basename(file) !== file) continue;

              const srcFile = path.join(srcServerDir, file);
              const dstFile = path.join(dstServerDir, file);
              if (!fs.existsSync(dstFile)) {
                const tmpFile = `${dstFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
                try {
                  fs.copyFileSync(srcFile, tmpFile);
                  if (srcFile.endsWith(".json")) {
                    JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
                  }
                  try {
                    fs.renameSync(tmpFile, dstFile);
                  } catch {
                    // Windows atomic rename fallback: direct copy + unlink if destination is locked or indexer open
                    fs.copyFileSync(tmpFile, dstFile);
                    try {
                      fs.unlinkSync(tmpFile);
                    } catch {}
                  }
                } catch (stageErr) {
                  try {
                    if (fs.existsSync(tmpFile)) {
                      fs.unlinkSync(tmpFile);
                    }
                  } catch {}
                  console.warn(`[McpMonitorService] Failed to provision schema ${entry.name}/${file}:`, stageErr);
                }
              }
            }
          } catch (serverErr) {
            console.warn(`[McpMonitorService] Failed to process directory ${entry.name}:`, serverErr);
          }
        }
      }
    } catch (globalErr) {
      console.warn("[McpMonitorService] Schema provisioning encountered an error:", globalErr);
    }
  }

  /**
   * Auto-provisions bundled MCP server execution configurations into ~/.gemini/config/mcp_config.json
   * ensuring gpt_architect and kins-agent-loop are runnable on fresh installs.
   */
  public provisionExecutionConfigs(): void {
    const rawHome = process.env.USERPROFILE || process.env.HOME || "";
    if (!rawHome || rawHome === "undefined" || rawHome === "null") return;
    const home = path.resolve(rawHome);
    const mcpConfigPath = path.join(home, ".gemini", "config", "mcp_config.json");

    try {
      let initialRaw = "";
      let config: Record<string, any> = { mcpServers: {} };
      if (fs.existsSync(mcpConfigPath)) {
        try {
          initialRaw = fs.readFileSync(mcpConfigPath, "utf-8");
          const parsed = JSON.parse(initialRaw);
          // MCP-01: Retain valid top-level configuration even if mcpServers is absent
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            config = parsed;
          } else {
            console.warn("[McpMonitorService] Existing mcp_config.json is not an object, skipping to prevent clobbering");
            return;
          }
        } catch {
          // MCP-02: Do not overwrite an unreadable/malformed existing configuration
          console.warn("[McpMonitorService] Failed to parse existing mcp_config.json, skipping execution provisioning to preserve recoverable state");
          return;
        }
      }

      if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
        config.mcpServers = {};
      }

      let changed = false;

      // 1. gpt_architect
      const packagedServerPy = (process as unknown as { resourcesPath?: string }).resourcesPath
        ? path.join((process as unknown as { resourcesPath: string }).resourcesPath, "bundled", "mcp-servers", "gpt_architect", "server.py")
        : null;
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      // In transpiled output (dist/src/main/services), app root is 4 levels up: ../../../..
      const appServerPyDist = path.resolve(currentDir, "..", "..", "..", "..", "resources", "bundled", "mcp-servers", "gpt_architect", "server.py");
      // In direct ts/source execution (src/main/services), app root is 3 levels up: ../../..
      const appServerPySrc = path.resolve(currentDir, "..", "..", "..", "resources", "bundled", "mcp-servers", "gpt_architect", "server.py");
      const repoServerPy = this.projectRoot
        ? path.join(this.projectRoot, "resources", "bundled", "mcp-servers", "gpt_architect", "server.py")
        : null;

      let gptServerPy: string | null = null;
      if (packagedServerPy && fs.existsSync(packagedServerPy)) {
        gptServerPy = packagedServerPy;
      } else if (repoServerPy && fs.existsSync(repoServerPy)) {
        gptServerPy = repoServerPy;
      } else if (fs.existsSync(appServerPyDist)) {
        gptServerPy = appServerPyDist;
      } else if (fs.existsSync(appServerPySrc)) {
        gptServerPy = appServerPySrc;
      }

      if (gptServerPy && !config.mcpServers.gpt_architect) {
        // Resolve Python interpreter from PATH (MCP-A01, MCP-A02, MCP-Q01)
        const pathEnv = process.env.PATH || "";
        const isWin = process.platform === "win32";
        const delimiter = (typeof path !== "undefined" && path.delimiter) ? path.delimiter : (isWin ? ";" : ":");
        const pathDirs = (pathEnv.includes(";") || delimiter === ";" || /^[a-zA-Z]:[/\\]/.test(pathEnv))
          ? pathEnv.split(";").filter(Boolean)
          : pathEnv.split(":").filter(Boolean);
        const rawExts = isWin ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM") : "";
        const pathExts = isWin ? rawExts.split(";").filter(Boolean) : [""];

        const probeCandidates = isWin
          ? [
              { cmd: "python", argsPrefix: [] as string[] },
              { cmd: "python3", argsPrefix: [] as string[] },
              { cmd: "py", argsPrefix: ["-3"] },
            ]
          : [
              { cmd: "python3", argsPrefix: [] as string[] },
              { cmd: "python", argsPrefix: [] as string[] },
            ];

        let resolvedPython: { command: string; args: string[] } | null = null;
        for (const candidate of probeCandidates) {
          let candidateFound = false;
          for (const dir of pathDirs) {
            for (const ext of pathExts) {
              const variations = isWin
                ? [
                    candidate.cmd + ext,
                    candidate.cmd + ext.toLowerCase(),
                    candidate.cmd + ext.toUpperCase(),
                    candidate.cmd
                  ]
                : [candidate.cmd];

              for (const fileCandidate of variations) {
                const fullPath = path.join(dir, fileCandidate);
                try {
                  if (fs.existsSync(fullPath)) {
                    // MCP-Q01: Bounded execution probe verifying Python major version 3
                    if (typeof spawnSync === "function") {
                      try {
                        const probe = spawnSync(candidate.cmd, [...candidate.argsPrefix, "--version"], {
                          stdio: ["ignore", "pipe", "pipe"],
                          encoding: "utf-8",
                          windowsHide: true,
                          timeout: 2000
                        });
                        const versionOutput = ((probe.stdout || "") + (probe.stderr || "")).trim();
                        if (probe.status === 0 && /^Python\s+3\./i.test(versionOutput)) {
                          candidateFound = true;
                          break;
                        }
                      } catch {}
                    } else {
                      // Fallback for sandboxed VM test harness without child_process
                      candidateFound = true;
                      break;
                    }
                  }
                } catch {}
              }
              if (candidateFound) break;
            }
            if (candidateFound) break;
          }
          if (candidateFound) {
            resolvedPython = {
              command: candidate.cmd,
              args: [...candidate.argsPrefix, gptServerPy]
            };
            break;
          }
        }

        if (!resolvedPython) {
          console.warn("[McpMonitorService] Python 3 runtime not found in PATH; gpt_architect will fail to launch until Python is installed and available in PATH");
          resolvedPython = {
            command: isWin ? "python" : "python3",
            args: [gptServerPy]
          };
        }

        const existingEnv = process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {};
        config.mcpServers.gpt_architect = {
          command: resolvedPython.command,
          args: resolvedPython.args,
          env: {
            ...existingEnv,
            OPENAI_MODEL: "gpt-6.1-sol",
            OPENAI_REASONING_EFFORT: "medium"
          }
        };
        changed = true;
      }

      // 2. kins-agent-loop
      const repoLoopJs = this.projectRoot ? path.join(this.projectRoot, "dist", "src", "loop", "mcp-server.js") : null;
      const appLoopJsDist = path.resolve(currentDir, "..", "..", "..", "..", "dist", "src", "loop", "mcp-server.js");
      const appLoopJsSrc = path.resolve(currentDir, "..", "..", "..", "dist", "src", "loop", "mcp-server.js");

      let loopJs: string | null = null;
      if (repoLoopJs && fs.existsSync(repoLoopJs)) {
        loopJs = repoLoopJs;
      } else if (fs.existsSync(appLoopJsDist)) {
        loopJs = appLoopJsDist;
      } else if (fs.existsSync(appLoopJsSrc)) {
        loopJs = appLoopJsSrc;
      }

      if (loopJs && !config.mcpServers["kins-agent-loop"]) {
        config.mcpServers["kins-agent-loop"] = {
          command: "node",
          args: [loopJs],
          env: {}
        };
        changed = true;
      }

      if (changed) {
        const dir = path.dirname(mcpConfigPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const tmpFile = `${mcpConfigPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          // MCP-Q02: Bounded optimistic concurrency loop preserving intervening configuration updates
          let committed = false;
          for (let attempt = 0; attempt < 3 && !committed; attempt++) {
            if (fs.existsSync(mcpConfigPath)) {
              try {
                const latestRaw = fs.readFileSync(mcpConfigPath, "utf-8");
                if (latestRaw !== initialRaw) {
                  const latestParsed = JSON.parse(latestRaw);
                  if (latestParsed && typeof latestParsed === "object" && !Array.isArray(latestParsed)) {
                    if (!latestParsed.mcpServers || typeof latestParsed.mcpServers !== "object") {
                      latestParsed.mcpServers = {};
                    }
                    for (const [serverKey, serverVal] of Object.entries(config.mcpServers)) {
                      if (!latestParsed.mcpServers[serverKey]) {
                        latestParsed.mcpServers[serverKey] = serverVal;
                      }
                    }
                    config = latestParsed;
                    initialRaw = latestRaw;
                  }
                }
              } catch {}
            }

            const serialized = JSON.stringify(config, null, 2) + "\n";
            fs.writeFileSync(tmpFile, serialized, { mode: 0o600, encoding: "utf-8" });

            if (fs.existsSync(mcpConfigPath)) {
              try {
                const preRenameRaw = fs.readFileSync(mcpConfigPath, "utf-8");
                if (preRenameRaw !== initialRaw) {
                  continue;
                }
              } catch {}
            }

            fs.renameSync(tmpFile, mcpConfigPath);
            committed = true;
          }
        } catch (renameErr) {
          console.warn("[McpMonitorService] Atomic replacement of mcp_config.json failed:", renameErr);
        } finally {
          try {
            if (fs.existsSync(tmpFile)) {
              fs.unlinkSync(tmpFile);
            }
          } catch {}
        }
      }
    } catch (err) {
      console.warn("[McpMonitorService] Failed to provision execution config:", err);
    }
  }

  getSnapshot(): McpSnapshot {
    return {
      servers: Array.from(this.servers.values()),
      recentCalls: [...this.recentCalls],
      lastUpdated: Date.now()
    };
  }

  async setProjectRoot(projectPath: string): Promise<void> {
    this.projectRoot = path.resolve(projectPath);
    this.refresh();
  }

  refresh(): McpSnapshot {
    this.provisionBundledSchemas();
    this.provisionExecutionConfigs();
    const discovered: McpServerInfo[] = [];

    // 1. Scan global ~/.gemini/antigravity*/mcp/ directories
    for (const dir of this.globalMcpDirs) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.endsWith(".disabled")) {
              if (discovered.some((s) => s.name === entry.name)) {
                continue;
              }
              const serverPath = path.join(dir, entry.name);
              const toolFiles = fs.readdirSync(serverPath).filter((f) => f.endsWith(".json"));
              const tools = toolFiles.map((f) => f.replace(/\.json$/, ""));
              discovered.push({
                name: entry.name,
                status: "connected",
                source: "global",
                tools,
                lastObserved: Date.now()
              });
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    // 2. Scan project MCP configs across multi-IDE standard paths
    for (const relPath of PROJECT_MCP_CONFIG_PATHS) {
      const candidatePath = path.join(this.projectRoot, relPath);
      if (fs.existsSync(candidatePath)) {
        try {
          const content = fs.readFileSync(candidatePath, "utf-8");
          const parsed = JSON.parse(content);
          if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
            for (const name of Object.keys(parsed.mcpServers)) {
              if (!discovered.some((s) => s.name === name)) {
                discovered.push({
                  name,
                  status: "configured",
                  source: "project",
                  tools: [],
                  lastObserved: Date.now()
                });
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    this.servers.clear();
    for (const server of discovered) {
      this.servers.set(server.name, server);
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  recordToolCall(
    record: Omit<ToolCallRecord, "id" | "timestamp"> & {
      timestamp?: number | undefined;
    }
  ): void {
    const timestamp =
      typeof record.timestamp === "number" &&
      Number.isFinite(record.timestamp) &&
      record.timestamp >= 0
        ? record.timestamp
        : Date.now();

    const call: ToolCallRecord = {
      ...record,
      id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp
    };
    this.recentCalls.unshift(call);
    if (this.recentCalls.length > 50) {
      this.recentCalls = this.recentCalls.slice(0, 50);
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  start(): void {
    this.refresh();
    this.pollTimer = setInterval(() => {
      this.refresh();
    }, 4000);
  }

  subscribe(listener: (snapshot: McpSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }
}
