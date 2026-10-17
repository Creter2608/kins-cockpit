#!/usr/bin/env node
/**
 * scripts/setup-mcp.mjs
 * Zero-config, idempotent MCP setup utility for Kin's Cockpit.
 * Provisons bundled MCP schemas and configures local execution configs
 * in ~/.gemini/config/mcp_config.json with cross-platform dynamic paths.
 * 
 * Non-conflicting with preflight and SystemReadinessService.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Sanitize candidate executable path against shell command injection.
 * @param {string} [candidate]
 * @returns {string | null}
 */
export function sanitizeExecPath(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  // Reject dangerous shell metacharacters
  if (/[&|;`$><\r\n]/.test(trimmed)) {
    return null;
  }
  // Allow normal alphanumeric path characters, spaces, and path separators
  if (!/^[a-zA-Z0-9_\-.:\\\/ "]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Detect available Python command on the host with argument prefixes.
 * Returns structured object { command: string, argsPrefix: string[], found: boolean }
 * @param {string} [preferred]
 * @returns {{ command: string; argsPrefix: string[]; found: boolean }}
 */
export function detectPythonCommand(preferred) {
  const sanitizedPreferred = sanitizeExecPath(preferred);
  if (sanitizedPreferred) {
    if (sanitizedPreferred === "py -3" || sanitizedPreferred.startsWith("py ")) {
      return { command: "py", argsPrefix: ["-3"], found: true };
    }
    return { command: sanitizedPreferred, argsPrefix: [], found: true };
  }

  const sanitizedEnv = sanitizeExecPath(process.env.PYTHON_PATH);
  if (sanitizedEnv) {
    if (sanitizedEnv === "py -3" || sanitizedEnv.startsWith("py ")) {
      return { command: "py", argsPrefix: ["-3"], found: true };
    }
    return { command: sanitizedEnv, argsPrefix: [], found: true };
  }

  // Probe candidates safely without spawning a shell
  const candidates = process.platform === "win32"
    ? [
        { cmd: "python", args: ["--version"], argsPrefix: [] },
        { cmd: "python3", args: ["--version"], argsPrefix: [] },
        { cmd: "py", args: ["-3", "--version"], argsPrefix: ["-3"] }
      ]
    : [
        { cmd: "python3", args: ["--version"], argsPrefix: [] },
        { cmd: "python", args: ["--version"], argsPrefix: [] }
      ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.cmd, candidate.args, { stdio: "ignore", timeout: 3000 });
      return { command: candidate.cmd, argsPrefix: candidate.argsPrefix, found: true };
    } catch {
      // try next candidate
    }
  }

  return {
    command: process.platform === "win32" ? "python" : "python3",
    argsPrefix: [],
    found: false
  };
}

/**
 * Detect available Node command on the host.
 * @param {string} [preferred]
 * @returns {string}
 */
export function detectNodeCommand(preferred) {
  const sanitized = sanitizeExecPath(preferred);
  if (sanitized) return sanitized;
  return process.execPath || "node";
}

/**
 * Check if CodeGraph CLI is available in PATH.
 * @returns {boolean}
 */
export function isCodeGraphAvailable() {
  try {
    execFileSync("codegraph", ["--version"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies schemas from resources/bundled/mcp-schemas/ into destination directories atomically.
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string[]} options.targetDirs
 * @returns {{ copied: string[]; skipped: string[]; errors: string[] }}
 */
export function provisionSchemas({ repoRoot, targetDirs }) {
  const bundledSchemasDir = path.join(repoRoot, "resources", "bundled", "mcp-schemas");
  const result = { copied: [], skipped: [], errors: [] };

  if (!fs.existsSync(bundledSchemasDir)) {
    return result;
  }

  try {
    const serverEntries = fs.readdirSync(bundledSchemasDir, { withFileTypes: true });
    for (const targetBase of targetDirs) {
      for (const entry of serverEntries) {
        if (!entry.isDirectory()) continue;
        // Defense against path traversal and NTFS ADS
        if (entry.name.includes("..") || entry.name.includes(":") || path.basename(entry.name) !== entry.name) continue;

        const srcServerDir = path.join(bundledSchemasDir, entry.name);
        const dstServerDir = path.join(targetBase, entry.name);

        try {
          if (!fs.existsSync(dstServerDir)) {
            fs.mkdirSync(dstServerDir, { recursive: true });
          }
          const files = fs.readdirSync(srcServerDir);
          for (const file of files) {
            // Defense against path traversal and NTFS ADS
            if (file.includes("..") || file.includes(":") || path.basename(file) !== file) continue;

            const srcFile = path.join(srcServerDir, file);
            const dstFile = path.join(dstServerDir, file);

            // Refuse following symlinks
            try {
              if (fs.lstatSync(srcFile).isSymbolicLink()) continue;
            } catch {
              continue;
            }

            // Always update if destination doesn't exist or content differs
            let needsCopy = true;
            if (fs.existsSync(dstFile)) {
              try {
                const srcContent = fs.readFileSync(srcFile);
                const dstContent = fs.readFileSync(dstFile);
                if (srcContent.equals(dstContent)) {
                  needsCopy = false;
                  result.skipped.push(`${entry.name}/${file}`);
                }
              } catch {
                needsCopy = true;
              }
            }

            if (needsCopy) {
              const tmpFile = `${dstFile}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
              try {
                fs.copyFileSync(srcFile, tmpFile);
                if (srcFile.endsWith(".json")) {
                  JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
                }
                // Atomic rename only
                fs.renameSync(tmpFile, dstFile);
                result.copied.push(`${entry.name}/${file}`);
              } catch (copyErr) {
                result.errors.push(`${entry.name}/${file}: ${copyErr.message}`);
              } finally {
                try {
                  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
                } catch {}
              }
            }
          }
        } catch (serverErr) {
          result.errors.push(`${entry.name}: ${serverErr.message}`);
        }
      }
    }
  } catch (err) {
    result.errors.push(`Global: ${err.message}`);
  }

  return result;
}

/**
 * Merges MCP execution configurations safely into ~/.gemini/config/mcp_config.json.
 * @param {object} options
 * @param {string} options.mcpConfigPath
 * @param {string} options.repoRoot
 * @param {string | object} [options.pythonCmd]
 * @param {string} [options.nodeCmd]
 * @param {boolean} [options.codegraphAvailable]
 * @param {string} [options.openAiKey]
 * @returns {{ updated: boolean; serversConfigured: string[]; config: object; pythonFound: boolean }}
 */
export function configureMcpServers({
  mcpConfigPath,
  repoRoot,
  pythonCmd,
  nodeCmd,
  codegraphAvailable,
  openAiKey
}) {
  const pyInfo = typeof pythonCmd === "object" && pythonCmd !== null && "command" in pythonCmd
    ? pythonCmd
    : detectPythonCommand(pythonCmd);
  const nd = detectNodeCommand(nodeCmd);
  const cgAvailable = codegraphAvailable !== undefined ? codegraphAvailable : isCodeGraphAvailable();

  let config = { mcpServers: {} };
  let originalRaw = "";

  if (fs.existsSync(mcpConfigPath)) {
    try {
      originalRaw = fs.readFileSync(mcpConfigPath, "utf-8");
      const parsed = JSON.parse(originalRaw);
      // MCP-01: Retain valid top-level object even if mcpServers is absent
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed;
      } else {
        console.warn("[setup-mcp] Existing config is not a JSON object, skipping modification to prevent data loss");
        return { updated: false, serversConfigured: [], config: {}, pythonFound: pyInfo.found };
      }
    } catch (parseErr) {
      // MCP-02: Do not overwrite an unreadable/malformed existing configuration
      console.warn(`[setup-mcp] Failed to parse existing ${mcpConfigPath}, skipping to preserve recoverable state: ${parseErr.message}`);
      return { updated: false, serversConfigured: [], config: {}, pythonFound: pyInfo.found };
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  const serversConfigured = [];

  // 1. Configure gpt_architect
  const gptServerPy = path.resolve(repoRoot, "resources", "bundled", "mcp-servers", "gpt_architect", "server.py");
  if (fs.existsSync(gptServerPy)) {
    const existingGpt = config.mcpServers.gpt_architect || {};
    const existingEnv = existingGpt.env || {};
    
    // SEC-04: Key precedence: explicit arg -> existing active key in file -> process.env.OPENAI_API_KEY
    const keyCandidate = (openAiKey && openAiKey.trim())
      || (typeof existingEnv.OPENAI_API_KEY === "string" && existingEnv.OPENAI_API_KEY.trim() ? existingEnv.OPENAI_API_KEY.trim() : "")
      || (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim())
      || "";

    const gptEnv = {
      ...(typeof existingEnv === "object" ? existingEnv : {})
    };

    if (keyCandidate) {
      gptEnv.OPENAI_API_KEY = keyCandidate;
    }
    if (!gptEnv.OPENAI_MODEL) {
      gptEnv.OPENAI_MODEL = "gpt-6.1-sol";
    }
    if (!gptEnv.OPENAI_REASONING_EFFORT) {
      gptEnv.OPENAI_REASONING_EFFORT = "medium";
    }

    // SEC-02: Separate command and argument prefix (fixes Windows py -3 spawn crash)
    config.mcpServers.gpt_architect = {
      command: pyInfo.command,
      args: [...(pyInfo.argsPrefix || []), gptServerPy],
      env: gptEnv
    };
    serversConfigured.push("gpt_architect");
  }

  // 2. Configure kins-agent-loop
  const loopServerJs = path.resolve(repoRoot, "dist", "src", "loop", "mcp-server.js");
  const existingLoop = config.mcpServers["kins-agent-loop"] || {};
  config.mcpServers["kins-agent-loop"] = {
    command: nd,
    args: [loopServerJs],
    env: typeof existingLoop.env === "object" ? existingLoop.env : {}
  };
  serversConfigured.push("kins-agent-loop");

  // 3. Configure codegraph (if available or previously configured)
  if (cgAvailable || config.mcpServers.codegraph) {
    const existingCg = config.mcpServers.codegraph || {};
    config.mcpServers.codegraph = {
      command: existingCg.command || "codegraph",
      args: existingCg.args || ["serve", "--mcp"]
    };
    serversConfigured.push("codegraph");
  }

  const serialized = JSON.stringify(config, null, 2) + "\n";
  const updated = serialized !== originalRaw;

  if (updated) {
    const dir = path.dirname(mcpConfigPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = `${mcpConfigPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      // SEC-03: Set owner-only mode 0o600 on config containing API secrets
      fs.writeFileSync(tmpPath, serialized, { mode: 0o600, encoding: "utf-8" });
      // MCP-03: Atomic rename only, no direct overwrite fallback
      fs.renameSync(tmpPath, mcpConfigPath);
    } catch (renameErr) {
      console.warn(`[setup-mcp] Atomic replacement failed: ${renameErr.message}`);
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {}
    }
  }

  return { updated, serversConfigured, config, pythonFound: pyInfo.found };
}

/**
 * Main setup routine.
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {string} [options.homeDir]
 * @param {string} [options.pythonCmd]
 * @param {string} [options.nodeCmd]
 * @param {string} [options.openAiKey]
 * @returns {{ success: boolean; schemas: object; servers: object; warnings: string[] }}
 */
export function setupMcp(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const rawHome = options.homeDir || process.env.USERPROFILE || process.env.HOME || os.homedir();
  const homeDir = path.resolve(rawHome);

  const targetDirs = [
    path.join(homeDir, ".gemini", "antigravity-cli", "mcp"),
    path.join(homeDir, ".gemini", "antigravity", "mcp")
  ];
  const mcpConfigPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");

  const warnings = [];

  // 1. Provision schemas
  const schemaResult = provisionSchemas({ repoRoot, targetDirs });

  // 2. Configure execution configs
  const serverResult = configureMcpServers({
    mcpConfigPath,
    repoRoot,
    pythonCmd: options.pythonCmd,
    nodeCmd: options.nodeCmd,
    openAiKey: options.openAiKey
  });

  // 3. Preflight & Dependency validation notifications
  if (!serverResult.pythonFound) {
    warnings.push("Python 3 was not detected in PATH. Install Python 3.10+ to enable gpt_architect MCP server.");
  }

  const gptConfig = serverResult.config?.mcpServers?.gpt_architect;
  if (gptConfig && (!gptConfig.env?.OPENAI_API_KEY || !gptConfig.env.OPENAI_API_KEY.trim())) {
    warnings.push("OPENAI_API_KEY is not configured yet. Set $env:OPENAI_API_KEY or configure in ~/.gemini/config/mcp_config.json.");
  }

  const loopJs = path.resolve(repoRoot, "dist", "src", "loop", "mcp-server.js");
  if (!fs.existsSync(loopJs)) {
    warnings.push("kins-agent-loop runtime not built yet (dist/src/loop/mcp-server.js). Run 'npm run build' before invoking kins-agent-loop.");
  }

  return {
    success: true,
    schemas: schemaResult,
    servers: serverResult,
    warnings
  };
}

// CLI Execution entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.stdout.write("====================================================\n");
    process.stdout.write(" Kin's Cockpit - Zero-Config MCP Setup Utility\n");
    process.stdout.write("====================================================\n\n");

    const result = setupMcp();

    process.stdout.write(`✅ Schemas provisioned: ${result.schemas.copied.length} copied, ${result.schemas.skipped.length} up-to-date\n`);
    if (result.schemas.errors.length > 0) {
      for (const err of result.schemas.errors) {
        process.stderr.write(`  ⚠️ Schema warning: ${err}\n`);
      }
    }

    process.stdout.write(`✅ Configured servers in ~/.gemini/config/mcp_config.json: ${result.servers.serversConfigured.join(", ")}\n`);
    if (result.servers.updated) {
      process.stdout.write(`  📝 mcp_config.json was safely updated\n`);
    } else {
      process.stdout.write(`  ✨ mcp_config.json is already up to date\n`);
    }

    if (result.warnings.length > 0) {
      process.stdout.write("\nNotifications:\n");
      for (const w of result.warnings) {
        process.stdout.write(`  ℹ️  ${w}\n`);
      }
    }

    process.stdout.write("\n🎉 MCP Setup Complete! All tools are now discoverable by Antigravity.\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`\n❌ Failed to setup MCP: ${err.message}\n`);
    process.exit(1);
  }
}
