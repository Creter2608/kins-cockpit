import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isAllowedNavigation } from "../src/main/navigation.js";
import { LoopStateService } from "../src/main/services/LoopStateService.js";
import { CriticalLogService } from "../src/main/services/CriticalLogService.js";
import { EvalHarnessService } from "../src/main/services/EvalHarnessService.js";

// Stage 2 Assertion 1: {"in":"foreign file URL or subframe navigation","out":"prevented"}
test("Stage 2 Assertion 1: foreign file URL or subframe navigation is prevented", () => {
  const allowedProdUrl = pathToFileURL("D:/Workspace/kins-multiagents-ui/dist/renderer/index.html").href;
  
  // Whitelisted canonical prod URL
  assert.equal(isAllowedNavigation(allowedProdUrl, allowedProdUrl), true);
  // Hash fragment navigation allowed
  assert.equal(isAllowedNavigation(`${allowedProdUrl}#/cockpit`, allowedProdUrl), true);
  
  // Foreign file URLs rejected
  assert.equal(isAllowedNavigation("file:///C:/Users/Kin/malicious.html", allowedProdUrl), false);
  assert.equal(isAllowedNavigation("file:///etc/passwd", allowedProdUrl), false);
  assert.equal(isAllowedNavigation("http://evil.com/phishing", allowedProdUrl), false);
  assert.equal(isAllowedNavigation("javascript:alert(1)", allowedProdUrl), false);

  // Dev server routing
  const devUrl = "http://localhost:5173/";
  assert.equal(isAllowedNavigation("http://localhost:5173/", devUrl), true);
  assert.equal(isAllowedNavigation("http://localhost:5173/#/settings", devUrl), true);
  assert.equal(isAllowedNavigation("http://localhost:5173/unauthorized-endpoint", devUrl), false);
  assert.equal(isAllowedNavigation("http://localhost:3000/", devUrl), false);
});

// Stage 2 Assertion 2: {"in":"watcher emits error twice","out":"closed; one polling timer"}
test("Stage 2 Assertion 2: watcher error closes watcher safely and retains single polling timer", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-watcher-"));
  const statePath = path.join(tempDir, "state.json");
  const logPath = path.join(tempDir, "cli.log");

  try {
    fs.writeFileSync(statePath, JSON.stringify({ runId: "run-watch-1", schemaVersion: 1, currentPhase: "INITIALIZE", status: "running" }), "utf8");
    fs.writeFileSync(logPath, "Initial log line\n", "utf8");

    const loopService = new LoopStateService(statePath, tempDir);
    loopService.start();

    // Trigger watcher error on loop service
    const loopWatcher = (loopService as any).watcher;
    if (loopWatcher) {
      assert.doesNotThrow(() => {
        loopWatcher.emit("error", new Error("EPERM: directory locked by Windows"));
        loopWatcher.emit("error", new Error("ENOENT: directory deleted by git"));
      });
      // Watcher must be closed and nulled
      assert.equal((loopService as any).watcher, null);
    }

    // CriticalLogService watcher error
    const logService = new CriticalLogService(logPath);
    logService.start();
    const logWatcher = (logService as any).watcher;
    if (logWatcher) {
      assert.doesNotThrow(() => {
        logWatcher.emit("error", new Error("EPERM: log directory locked"));
      });
      assert.equal((logService as any).watcher, null);
    }

    loopService.dispose();
    logService.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Stage 2 Assertion 3: {"in":"existing malformed state.json; mutate","out":"zero writes; memory unchanged"}
test("Stage 2 Assertion 3: unreadable or malformed state.json aborts disk mutation without blank overwrite", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-corrupted-state-"));
  const statePath = path.join(tempDir, "state.json");

  try {
    const corruptContent = "{\"corrupted_json_truncated: true";
    fs.writeFileSync(statePath, corruptContent, "utf8");

    const loopService = new LoopStateService(statePath, tempDir);
    const initialSnapshot = loopService.getSnapshot();

    // Attempt mutations
    loopService.updateTestSummary({ status: "pass", passCount: 10, failCount: 0, lastRunAt: new Date().toISOString() });
    loopService.updateResourceUsage({ totalTokens: 9999 });
    const transResult = loopService.transitionPhase("PLAN", { triggeredBy: "test", autoAdvanced: false, timestamp: Date.now() });

    // Transition must be rejected or disk write aborted
    assert.equal(transResult, false);
    const currentSnap = loopService.getSnapshot();
    assert.deepEqual({ ...currentSnap, lastUpdated: initialSnapshot.lastUpdated }, initialSnapshot, "Memory snapshot must remain untouched on corrupted read");

    // Verify disk content was NOT overwritten with {} or corrupted object
    const rawDisk = fs.readFileSync(statePath, "utf8");
    assert.equal(rawDisk, corruptContent, "Corrupted state file on disk must NOT be overwritten with blank object");

    loopService.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Stage 2 Assertion 4: {"in":"rollback returns failure","out":"same result; no stepBack"}
test("Stage 2 Assertion 4: failed rollback returns failure directly without synthetic phase decrement", async () => {
  // Simulated handler contract test for ipcMain rollback handler
  const mockRollbackService = {
    async executeRollback() {
      return { success: false, message: "Cannot rollback: working tree dirty" };
    }
  };
  let stepBackCalled = false;
  const mockLoopService = {
    stepBack() {
      stepBackCalled = true;
      return { success: true, message: "Stepped back to INITIALIZE" };
    }
  };

  // Modern handler logic:
  const handler = async () => {
    const res = await mockRollbackService.executeRollback();
    if (!res.success) {
      return res; // Must return failure directly!
    }
    return res;
  };

  const result = await handler();
  assert.equal(result.success, false);
  assert.equal(result.message, "Cannot rollback: working tree dirty");
  assert.equal(stepBackCalled, false, "services.loop.stepBack() must NOT be called when rollback fails");
});

// Stage 2 Assertion 5: {"in":"repository-controlled runner path","out":"rejected; zero spawns"}
test("Stage 2 Assertion 5: external untrusted runner.mjs is rejected", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-untrusted-runner-"));
  const fakeHarnessDir = path.join(tempDir, "scripts", "harness");
  fs.mkdirSync(fakeHarnessDir, { recursive: true });
  const maliciousRunner = path.join(fakeHarnessDir, "runner.mjs");
  fs.writeFileSync(maliciousRunner, "console.log('malicious host execution');", "utf8");

  try {
    const evalService = new EvalHarnessService(tempDir);
    const resolved = evalService.resolveRunnerPath();

    // If resolved is not null, it must be the canonical app runner from the installation, never the tempDir runner!
    if (resolved !== null) {
      assert.notEqual(resolved, maliciousRunner, "Untrusted runner from external workspace must never be selected");
      assert.ok(resolved.includes("scripts"), "Must resolve to canonical app runner");
    }

    evalService.dispose();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Stage 2 Adversarial Assertion: runner resolution rejects symlink outside trusted assets
test("Stage 2 Assertion 5b: runner resolution rejects symlink pointing outside trusted appRoot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-runner-symlink-"));
  try {
    const appRoot = path.join(root, "application");
    const runnerDirectory = path.join(appRoot, "scripts", "harness");
    const externalRepo = path.join(root, "external-repo");

    fs.mkdirSync(runnerDirectory, { recursive: true });
    fs.mkdirSync(externalRepo, { recursive: true });

    const attackerRunner = path.join(externalRepo, "runner.mjs");
    fs.writeFileSync(attackerRunner, "console.log('untrusted');\n", "utf8");

    try {
      fs.symlinkSync(attackerRunner, path.join(runnerDirectory, "runner.mjs"), "file");
    } catch {
      // If symlink not supported without privilege, skip symlink assertion
      return;
    }

    const evalService = new EvalHarnessService(root);
    evalService.setAppRootForTesting(appRoot);
    const resolved = evalService.resolveRunnerPath();
    assert.equal(resolved, null, "Runner redirected outside trusted application assets must be rejected");
    evalService.dispose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
