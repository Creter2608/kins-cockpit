import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
    const appBundledDir = path.resolve(currentDir, "..", "..", "..", "resources", "bundled", "mcp-schemas");
    const repoDir = path.join(this.projectRoot, "resources", "bundled", "mcp-schemas");

    let bundledSchemasDir: string | null = null;
    if (packagedDir && fs.existsSync(packagedDir)) {
      bundledSchemasDir = packagedDir;
    } else if (fs.existsSync(appBundledDir)) {
      bundledSchemasDir = appBundledDir;
    } else if (fs.existsSync(repoDir)) {
      bundledSchemasDir = repoDir;
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
