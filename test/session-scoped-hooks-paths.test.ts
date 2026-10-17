import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWorkspaceStateFile } from "../src/shared/workspaceStatePaths.js";
import { evaluatePreToolUseHook } from "../src/cli/preToolUseHook.js";
import { PreToolUseHookService, resolveDefaultRuntimeCommand } from "../src/main/services/preToolUseHookService.js";
import { buildSanitizedPtyEnv } from "../src/main/services/PtyService.js";

// Golden Assertion 1: {"in":"Fresh CLI, no registry or state","out":"Initialize sidecar; no repo .ai"}
test("workspaceStatePaths: initialize when neither exists selects sidecar without creating .ai in repo", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsp-test-"));
  try {
    const sidecarFile = path.join(tempDir, "userData", "sidecar", "state", "state.json");
    const resolution = resolveWorkspaceStateFile(
      {
        canonicalWorkspaceRoot: tempDir,
        sidecarStateFile: sidecarFile
      },
      "initialize"
    );
    assert.equal(resolution.source, "sidecar");
    assert.equal(resolution.stateFile, path.resolve(sidecarFile));
    assert.equal(fs.existsSync(path.join(tempDir, ".ai")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Golden Assertion 2: {"in":"Legacy-only or sidecar-only valid state","out":"Selects existing file"}
test("workspaceStatePaths: selects existing legacy or sidecar file seamlessly", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsp-test-"));
  try {
    const legacyDir = path.join(tempDir, ".ai");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "state.json");
    fs.writeFileSync(legacyFile, JSON.stringify({ runId: "legacy-run-1" }), "utf-8");

    const sidecarFile = path.join(tempDir, "userData", "sidecar", "state", "state.json");

    // When legacy exists and sidecar does not -> selects legacy
    const resLegacy = resolveWorkspaceStateFile(
      { canonicalWorkspaceRoot: tempDir, sidecarStateFile: sidecarFile },
      "read"
    );
    assert.equal(resLegacy.source, "legacy");
    assert.equal(resLegacy.stateFile, path.resolve(legacyFile));

    // When both exist and have identical contents -> selects sidecar and notes duplicate
    fs.mkdirSync(path.dirname(sidecarFile), { recursive: true });
    fs.writeFileSync(sidecarFile, JSON.stringify({ runId: "legacy-run-1" }), "utf-8");

    const resBoth = resolveWorkspaceStateFile(
      { canonicalWorkspaceRoot: tempDir, sidecarStateFile: sidecarFile },
      "read"
    );
    assert.equal(resBoth.source, "sidecar");
    assert.equal(resBoth.stateFile, path.resolve(sidecarFile));
    assert.equal(resBoth.duplicateLegacyFile, path.resolve(legacyFile));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Golden Assertion 3: {"in":"Two divergent states","out":"STATE_PATH_CONFLICT; zero writes"}
test("workspaceStatePaths: throws STATE_PATH_CONFLICT when both files exist with different contents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wsp-test-"));
  try {
    const legacyDir = path.join(tempDir, ".ai");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "state.json");
    fs.writeFileSync(legacyFile, JSON.stringify({ runId: "run-A" }), "utf-8");

    const sidecarFile = path.join(tempDir, "userData", "sidecar", "state", "state.json");
    fs.mkdirSync(path.dirname(sidecarFile), { recursive: true });
    fs.writeFileSync(sidecarFile, JSON.stringify({ runId: "run-B" }), "utf-8");

    assert.throws(
      () => {
        resolveWorkspaceStateFile(
          { canonicalWorkspaceRoot: tempDir, sidecarStateFile: sidecarFile },
          "read"
        );
      },
      /STATE_PATH_CONFLICT/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Golden Assertion 4: {"in":"External CLI / VS Code session; no KINS_COCKPIT_ACTIVE","out":"Pass-through allow"}
test("preToolUseHook: external session without KINS_COCKPIT_ACTIVE immediately passes through", async () => {
  const payload = {
    toolCall: {
      name: "write_to_file",
      args: {
        TargetFile: "C:/Projects/my-external-project/index.ts"
      }
    }
  };

  // Explicit non-cockpit env
  const decision = await evaluatePreToolUseHook(payload, {
    env: {
      NODE_ENV: "production",
      KINS_COCKPIT_ACTIVE: undefined
    }
  });

  assert.equal(decision.decision, "allow");
  assert.match(decision.reason || "", /Pass-through/);
});

// Golden Assertion 5: {"in":"Cockpit session writing outside workspace","out":"deny"}
test("preToolUseHook: Cockpit session writing outside workspace is strictly denied", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "userData-"));
  const tempWs = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-ws-"));
  try {
    const service = new PreToolUseHookService();
    await service.equipWorkspace({
      workspaceRoot: tempWs,
      userDataPath: tempUserDir,
      sidecarStatePath: path.join(tempUserDir, "state", "state.json")
    });

    const payload = {
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: "C:/Windows/System32/drivers/etc/hosts"
        }
      }
    };

    const decision = await evaluatePreToolUseHook(payload, {
      userDataPath: tempUserDir,
      env: {
        KINS_COCKPIT_ACTIVE: "1",
        NODE_ENV: "production"
      }
    });

    assert.equal(decision.decision, "deny");
    assert.match(decision.reason || "", /outside any registered Cockpit workspace/);
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempWs, { recursive: true, force: true });
  }
});

// Golden Assertion 6: {"in":"Register Cockpit hooks","out":"User-data config only; global untouched"}
test("preToolUseHookService: default hooksConfigPath is scoped to userData", async () => {
  const tempUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "userData-"));
  const tempWs = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-ws-"));
  try {
    const service = new PreToolUseHookService();
    const equipped = await service.equipWorkspace({
      workspaceRoot: tempWs,
      userDataPath: tempUserDir,
      sidecarStatePath: path.join(tempUserDir, "state", "state.json")
    });

    // Verify hooksConfigPath is inside tempUserDir, not user home
    assert.equal(equipped.hooksConfigPath.startsWith(path.resolve(tempUserDir)), true);
    assert.equal(fs.existsSync(equipped.hooksConfigPath), true);
  } finally {
    fs.rmSync(tempUserDir, { recursive: true, force: true });
    fs.rmSync(tempWs, { recursive: true, force: true });
  }
});

// Golden Assertion 7: {"in":"Runtime command path with spaces","out":"Quoted command string"}
test("resolveDefaultRuntimeCommand: quotes hook script path only when containing spaces (PITFALL-024)", () => {
  const quotedCmd = resolveDefaultRuntimeCommand("C:/Program Files/Kins Cockpit/hook.js");
  assert.equal(quotedCmd, 'node "C:/Program Files/Kins Cockpit/hook.js"');

  const unquotedCmd = resolveDefaultRuntimeCommand("C:/tools/hook.js");
  assert.equal(unquotedCmd, "node C:/tools/hook.js");

  const defaultCmd = resolveDefaultRuntimeCommand();
  if (defaultCmd.replace(/^node /, "").includes(" ")) {
    assert.match(defaultCmd, /^node "[^"]+"/);
  } else {
    assert.match(defaultCmd, /^node \S+/);
  }
});

// Golden Assertion 8: {"in":"PtyService environment","out":"Contains ANTIGRAVITY_HOOKS_CONFIG_PATH"}
test("buildSanitizedPtyEnv: propagates ANTIGRAVITY_HOOKS_CONFIG_PATH in workspace context", () => {
  const tempSidecar = "C:\\Users\\Test\\AppData\\Roaming\\kins-cockpit\\workspaces\\ws-1";
  const env = buildSanitizedPtyEnv({}, {
    id: "ws-1",
    root: "C:\\Projects\\my-project",
    displayName: "my-project",
    sidecarDirectory: tempSidecar,
    rules: []
  });

  assert.equal(env["KINS_COCKPIT_ACTIVE"], "1");
  assert.equal(env["ANTIGRAVITY_HOOKS_CONFIG_PATH"], "C:\\Users\\Test\\AppData\\Roaming\\kins-cockpit\\hooks\\hooks.json");
  assert.equal(env["ANTIGRAVITY_HOOK_USER_DATA"], "C:\\Users\\Test\\AppData\\Roaming\\kins-cockpit");
});
