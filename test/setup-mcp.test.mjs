import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  setupMcp,
  provisionSchemas,
  configureMcpServers,
  detectPythonCommand,
  detectNodeCommand,
  sanitizeExecPath
} from "../scripts/setup-mcp.mjs";
import { extractOpenAiKeyFromMcpJson } from "../dist/src/main/services/credentialMasker.js";

test("setup-mcp: sanitizeExecPath blocks shell injection metacharacters", () => {
  assert.equal(sanitizeExecPath("python.exe & calc.exe"), null, "Must block shell & operator");
  assert.equal(sanitizeExecPath("python; rm -rf /"), null, "Must block semicolon injection");
  assert.equal(sanitizeExecPath("python | nc"), null, "Must block pipe injection");
  assert.equal(sanitizeExecPath("`whoami`"), null, "Must block backtick injection");
  assert.equal(sanitizeExecPath("$(whoami)"), null, "Must block subshell injection");
  assert.equal(sanitizeExecPath("C:\\Python313\\python.exe"), "C:\\Python313\\python.exe", "Must allow valid Windows path");
  assert.equal(sanitizeExecPath("/usr/bin/python3"), "/usr/bin/python3", "Must allow valid POSIX path");
});

test("setup-mcp: detectPythonCommand returns valid candidate and handles py -3", () => {
  const py = detectPythonCommand();
  assert.ok(typeof py.command === "string" && py.command.length > 0, "Python command must be a non-empty string");
  assert.ok(Array.isArray(py.argsPrefix), "argsPrefix must be an array");

  const custom = detectPythonCommand("C:\\Custom\\Python\\python.exe");
  assert.equal(custom.command, "C:\\Custom\\Python\\python.exe", "Custom preferred command must be respected");

  const pyLauncher = detectPythonCommand("py -3");
  assert.equal(pyLauncher.command, "py", "py -3 command must be separated into executable 'py'");
  assert.deepEqual(pyLauncher.argsPrefix, ["-3"], "py -3 flag must be placed into argsPrefix");
});

test("setup-mcp: detectNodeCommand returns valid candidate", () => {
  const nd = detectNodeCommand();
  assert.ok(typeof nd === "string" && nd.length > 0, "Node command must be a non-empty string");

  const custom = detectNodeCommand("/usr/local/bin/node");
  assert.equal(custom, "/usr/local/bin/node", "Custom preferred command must be respected");
});

test("setup-mcp: provisionSchemas synchronizes schemas and is idempotent", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "setup-mcp-test-"));
  const tempHome = path.join(tempRoot, "home");
  const tempRepo = path.join(tempRoot, "repo");

  try {
    // 1. Setup mock bundled schemas
    const bundledDir = path.join(tempRepo, "resources", "bundled", "mcp-schemas", "test-server");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "tool_1.json"), JSON.stringify({ name: "tool_1" }), "utf-8");

    const target1 = path.join(tempHome, ".gemini", "antigravity-cli", "mcp");
    const target2 = path.join(tempHome, ".gemini", "antigravity", "mcp");

    // First run: copies schema
    const run1 = provisionSchemas({ repoRoot: tempRepo, targetDirs: [target1, target2] });
    assert.equal(run1.copied.length, 2, "Should copy to both target directories");
    assert.ok(fs.existsSync(path.join(target1, "test-server", "tool_1.json")));
    assert.ok(fs.existsSync(path.join(target2, "test-server", "tool_1.json")));

    // Second run: idempotent, skips already-identical files
    const run2 = provisionSchemas({ repoRoot: tempRepo, targetDirs: [target1, target2] });
    assert.equal(run2.copied.length, 0, "Second run should not recopy identical schemas");
    assert.equal(run2.skipped.length, 2, "Second run should report skipped schemas");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup-mcp: configureMcpServers creates and merges servers without clobbering existing configuration", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "setup-mcp-config-"));
  const mcpConfigPath = path.join(tempRoot, "config", "mcp_config.json");
  const tempRepo = path.join(tempRoot, "repo");

  try {
    // 1. Create a dummy gpt_architect server.py in repo
    const gptServerDir = path.join(tempRepo, "resources", "bundled", "mcp-servers", "gpt_architect");
    fs.mkdirSync(gptServerDir, { recursive: true });
    fs.writeFileSync(path.join(gptServerDir, "server.py"), "# mock server", "utf-8");

    // 2. Pre-seed mcp_config.json with an existing third-party server and unrelated property
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    const initialConfig = {
      preferences: { theme: "solarized" },
      mcpServers: {
        "sqlite-helper": {
          command: "sqlite-mcp",
          args: ["/data/mydb.db"]
        }
      }
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(initialConfig, null, 2), "utf-8");

    // 3. Run configureMcpServers with py -3
    const res1 = configureMcpServers({
      mcpConfigPath,
      repoRoot: tempRepo,
      pythonCmd: "py -3",
      nodeCmd: "node",
      codegraphAvailable: true,
      openAiKey: "sk-proj-test-key-12345"
    });

    assert.equal(res1.updated, true, "Config should be marked as updated");
    assert.ok(res1.serversConfigured.includes("gpt_architect"));
    assert.ok(res1.serversConfigured.includes("kins-agent-loop"));
    assert.ok(res1.serversConfigured.includes("codegraph"));

    // Verify written file
    const content = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
    assert.deepEqual(content.preferences, { theme: "solarized" }, "Unrelated preferences must be preserved (MCP-01)");
    assert.ok(content.mcpServers["sqlite-helper"], "Existing third-party server must be preserved");
    assert.equal(content.mcpServers["sqlite-helper"].command, "sqlite-mcp");
    assert.equal(content.mcpServers.gpt_architect.env.OPENAI_API_KEY, "sk-proj-test-key-12345");
    assert.equal(content.mcpServers.gpt_architect.command, "py", "py launcher command must be 'py'");
    assert.deepEqual(content.mcpServers.gpt_architect.args, ["-3", path.join(gptServerDir, "server.py")], "args must separate -3 prefix");

    // 4. Run second time: must be idempotent and preserve existing active key (SEC-04)
    const res2 = configureMcpServers({
      mcpConfigPath,
      repoRoot: tempRepo,
      pythonCmd: "py -3",
      nodeCmd: "node",
      codegraphAvailable: true
    });
    assert.equal(res2.updated, false, "Second run with identical params should not modify file");
    assert.equal(res2.config.mcpServers.gpt_architect.env.OPENAI_API_KEY, "sk-proj-test-key-12345", "Key must be preserved on second run");

    // 5. Verify Preflight / SystemReadiness compatibility
    const rawSaved = fs.readFileSync(mcpConfigPath, "utf-8");
    const keyExtraction = extractOpenAiKeyFromMcpJson(rawSaved);
    assert.equal(keyExtraction.error, undefined, "Must not cause conflicting or malformed preflight error");
    assert.equal(keyExtraction.key, "sk-proj-test-key-12345", "Preflight must be able to extract OpenAI key cleanly");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup-mcp: configureMcpServers preserves malformed config without clobbering (MCP-02)", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "setup-mcp-corrupt-"));
  const mcpConfigPath = path.join(tempRoot, "config", "mcp_config.json");
  const tempRepo = path.join(tempRoot, "repo");

  try {
    fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    const malformedContent = "{ INVALID_JSON_BODY ...";
    fs.writeFileSync(mcpConfigPath, malformedContent, "utf-8");

    const res = configureMcpServers({
      mcpConfigPath,
      repoRoot: tempRepo,
      pythonCmd: "python",
      nodeCmd: "node"
    });

    assert.equal(res.updated, false, "Must not overwrite a malformed configuration");
    assert.equal(fs.readFileSync(mcpConfigPath, "utf-8"), malformedContent, "Original malformed content must remain untouched");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("setup-mcp: setupMcp end-to-end creates complete workspace config and notifications", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "setup-mcp-e2e-"));
  const tempHome = path.join(tempRoot, "home");
  const tempRepo = path.join(tempRoot, "repo");

  try {
    const bundledDir = path.join(tempRepo, "resources", "bundled", "mcp-schemas", "gpt_architect");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "tool.json"), JSON.stringify({ name: "tool" }), "utf-8");

    // Test missing Python detection produces warning
    const resultNoPython = setupMcp({
      repoRoot: tempRepo,
      homeDir: tempHome,
      pythonCmd: { command: "nonexistent_python_binary", argsPrefix: [], found: false },
      nodeCmd: "node"
    });

    assert.equal(resultNoPython.success, true);
    assert.ok(resultNoPython.warnings.some(w => w.includes("Python 3 was not detected")), "Must warn when Python 3 is missing");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
