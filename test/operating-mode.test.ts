/**
 * test/operating-mode.test.ts
 * Comprehensive test suite for Tri-State Operating Switch (Discussion / Tweak / Loop).
 * Validates:
 * 1. Monotonic revision state & transitions in OperatingModeService
 * 2. Discussion mode 100% read-only policy enforcement
 * 3. Tweak mode bounded mutation ceilings (≤3 files, whitelist enforcement, protected paths)
 * 4. Loop mode delegation to 10-phase pipeline
 * 5. PreToolUse CLI Hook integration
 * 6. Compact golden test assertions from Stage 2 Technical Blueprint
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { OperatingModeService } from "../src/main/services/OperatingModeService.js";
import {
  evaluateOperatingModeMutationPolicy,
  isTweakProtectedPath
} from "../src/shared/workspaceMutationPolicy.js";
import type { TweakScope } from "../src/shared/operatingMode.js";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";
import { evaluatePreToolUseHook } from "../src/cli/preToolUseHook.js";

test("OperatingModeService: lifecycle, monotonic revision & transitions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opmode-test-"));
  try {
    const service = new OperatingModeService(tmpDir);
    const ws = "/test/workspace";

    // 1. Initial snapshot defaults to loop with revision 1
    const initial = service.getSnapshot(ws);
    assert.equal(initial.mode, "loop");
    assert.equal(initial.revision, 1);

    // 2. Transition to discussion increments revision
    let eventReceived: any = null;
    service.on("modeChanged", (snap) => {
      eventReceived = snap;
    });

    const updated = await service.setMode({
      workspaceId: ws,
      expectedRevision: 1,
      mode: "discussion"
    });
    assert.equal(updated.mode, "discussion");
    assert.equal(updated.revision, 2);
    assert.equal(eventReceived?.mode, "discussion");
    assert.equal(eventReceived?.revision, 2);

    // 3. Stale revision transition is rejected
    await assert.rejects(
      service.setMode({
        workspaceId: ws,
        expectedRevision: 1, // Stale!
        mode: "tweak"
      }),
      /Revision conflict/
    );

    // 4. Valid revision transition to tweak succeeds
    const tweakScope: TweakScope = {
      transactionId: "tx-1",
      allowedRelativePaths: ["src/file1.ts", "src/file2.ts"],
      maxFiles: 3,
      maxLineBudget: 120,
      expiresAtMs: Date.now() + 60000
    };

    const tweakSnap = await service.setMode({
      workspaceId: ws,
      expectedRevision: 2,
      mode: "tweak",
      tweakScope
    });
    assert.equal(tweakSnap.mode, "tweak");
    assert.equal(tweakSnap.revision, 3);
    assert.deepEqual(tweakSnap.tweakScope, tweakScope);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("evaluateOperatingModeMutationPolicy: Golden Assertion 1 - discussion + write -> deny", () => {
  const result = evaluateOperatingModeMutationPolicy(
    { mode: "discussion" },
    ["src/any-file.ts"],
    process.cwd()
  );
  assert.equal(result.allowed, false);
  assert.equal(result.rejectionCode, "DISCUSSION_READONLY");
  assert.match(result.reason, /Read-only/);
});

test("evaluateOperatingModeMutationPolicy: Golden Assertion 2 - tweak with approved files -> allow without Oracle", () => {
  const scope: TweakScope = {
    transactionId: "tx-ok",
    allowedRelativePaths: ["src/renderer/App.tsx", "src/utils.ts"],
    maxFiles: 3,
    maxLineBudget: 120,
    expiresAtMs: Date.now() + 60000
  };

  const result = evaluateOperatingModeMutationPolicy(
    { mode: "tweak", tweakScope: scope },
    ["src/renderer/App.tsx"],
    process.cwd()
  );
  assert.equal(result.allowed, true);
  assert.equal(result.mode, "tweak");
});

test("evaluateOperatingModeMutationPolicy: Golden Assertion 3 - tweak exceeding 3 files -> deny before write", () => {
  const result = evaluateOperatingModeMutationPolicy(
    { mode: "tweak" },
    ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], // 4 files!
    process.cwd()
  );
  assert.equal(result.allowed, false);
  assert.equal(result.rejectionCode, "TWEAK_FILE_LIMIT_EXCEEDED");
  assert.match(result.reason, /tối đa 3 tập tin/);
});

test("evaluateOperatingModeMutationPolicy: Golden Assertion 4 - tweak protected path / .eval escape -> deny", () => {
  // Test .eval/
  const evalResult = evaluateOperatingModeMutationPolicy(
    { mode: "tweak" },
    [".eval/golden.json"],
    process.cwd()
  );
  assert.equal(evalResult.allowed, false);
  assert.equal(evalResult.rejectionCode, "PROTECTED_PATH");

  // Test package.json
  const pkgResult = evaluateOperatingModeMutationPolicy(
    { mode: "tweak" },
    ["package.json"],
    process.cwd()
  );
  assert.equal(pkgResult.allowed, false);
  assert.equal(pkgResult.rejectionCode, "PROTECTED_PATH");
  assert.match(pkgResult.reason, /nhạy cảm/);

  // Helper check
  assert.equal(isTweakProtectedPath(".git/HEAD"), true);
  assert.equal(isTweakProtectedPath(".ai/blueprint.md"), true);
  assert.equal(isTweakProtectedPath("tsconfig.json"), true);
  assert.equal(isTweakProtectedPath("src/normal.ts"), false);
});

test("evaluateOperatingModeMutationPolicy: tweak unapproved path in scope -> deny", () => {
  const scope: TweakScope = {
    transactionId: "tx-scoped",
    allowedRelativePaths: ["src/target.ts"],
    maxFiles: 3,
    maxLineBudget: 120,
    expiresAtMs: Date.now() + 60000
  };

  const result = evaluateOperatingModeMutationPolicy(
    { mode: "tweak", tweakScope: scope },
    ["src/unapproved.ts"],
    process.cwd()
  );
  assert.equal(result.allowed, false);
  assert.equal(result.rejectionCode, "TWEAK_PATH_UNAPPROVED");
});

test("evaluateOperatingModeMutationPolicy: tweak expired scope -> deny", () => {
  const scope: TweakScope = {
    transactionId: "tx-expired",
    allowedRelativePaths: ["src/target.ts"],
    maxFiles: 3,
    maxLineBudget: 120,
    expiresAtMs: Date.now() - 1000 // Expired!
  };

  const result = evaluateOperatingModeMutationPolicy(
    { mode: "tweak", tweakScope: scope },
    ["src/target.ts"],
    process.cwd()
  );
  assert.equal(result.allowed, false);
  assert.equal(result.rejectionCode, "TRANSACTION_EXPIRED");
});

test("evaluateOperatingModeMutationPolicy: loop mode delegates to loop pipeline", () => {
  const result = evaluateOperatingModeMutationPolicy(
    { mode: "loop" },
    ["src/feature.ts"],
    process.cwd()
  );
  assert.equal(result.allowed, true);
  assert.equal(result.mode, "loop");
});

test("PreToolUseHook: Discussion mode denies replace_file_content immediately", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-opmode-test-"));
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "hook-ws-"));
  try {
    const signingKey = await PreToolUseHookService.getOrCreateSigningKey(tmpDir);

    const hookService = new PreToolUseHookService();
    // Equip workspace with operatingMode = discussion
    await hookService.equipWorkspace({
      workspaceRoot: tmpWs,
      sidecarStatePath: path.join(tmpDir, "state.json"),
      userDataPath: tmpDir,
      operatingMode: "discussion",
      authorizationRevision: 1
    });

    const targetFile = path.join(tmpWs, "test.ts");
    await fs.writeFile(targetFile, "console.log('original');");

    const decision = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "replace_file_content",
          args: {
            TargetFile: targetFile,
            ReplacementContent: "console.log('edited');"
          }
        },
        workspacePaths: [tmpWs]
      },
      {
        userDataPath: tmpDir,
        env: { KINS_COCKPIT_ACTIVE: "1" }
      }
    );

    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /Chế độ Thảo luận/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("PreToolUseHook: Tweak mode allows valid edit without Stage 2 Blueprint", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-tweak-test-"));
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "hook-tweak-ws-"));
  try {
    const signingKey = await PreToolUseHookService.getOrCreateSigningKey(tmpDir);

    const hookService = new PreToolUseHookService();
    // Equip workspace with operatingMode = tweak
    await hookService.equipWorkspace({
      workspaceRoot: tmpWs,
      sidecarStatePath: path.join(tmpDir, "state.json"),
      userDataPath: tmpDir,
      operatingMode: "tweak",
      authorizationRevision: 1,
      tweakScope: {
        transactionId: "tx-hook-1",
        allowedRelativePaths: ["src/component.tsx"],
        maxFiles: 3,
        maxLineBudget: 120,
        expiresAtMs: Date.now() + 60000
      }
    });

    const targetFile = path.join(tmpWs, "src", "component.tsx");
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.writeFile(targetFile, "export const X = 1;");

    const decision = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "replace_file_content",
          args: {
            TargetFile: targetFile,
            ReplacementContent: "export const X = 2;"
          }
        },
        workspacePaths: [tmpWs]
      },
      {
        userDataPath: tmpDir,
        env: { KINS_COCKPIT_ACTIVE: "1" }
      }
    );

    assert.equal(decision.decision, "allow");
    assert.match(decision.reason, /Tinh chỉnh/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});

test("OperatingModeService: tweakScope is completely deleted from HMAC registry when leaving tweak mode", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opmode-scope-cleanup-"));
  const ws = path.join(tmpDir, "cleanup-ws");
  try {
    const hookService = new PreToolUseHookService();
    await hookService.equipWorkspace({
      workspaceRoot: ws,
      sidecarStatePath: path.join(tmpDir, "state.json"),
      userDataPath: tmpDir,
      operatingMode: "tweak",
      authorizationRevision: 1,
      tweakScope: {
        transactionId: "tx-cleanup",
        allowedRelativePaths: ["src/a.ts"],
        maxFiles: 3,
        maxLineBudget: 120,
        expiresAtMs: Date.now() + 60000
      }
    });

    const registryPath = path.join(tmpDir, "hooks", "workspaces.json");
    const rawBefore = await fs.readFile(registryPath, "utf-8");
    const regBefore = JSON.parse(rawBefore);
    const canonicalWs = Object.keys(regBefore.workspaces)[0];
    assert.ok(canonicalWs);
    assert.ok(regBefore.workspaces[canonicalWs].tweakScope);

    const service = new OperatingModeService(tmpDir);
    // Transition to discussion (which has no tweakScope)
    await service.setMode({
      workspaceId: ws,
      expectedRevision: 1,
      mode: "discussion"
    });

    const rawAfter = await fs.readFile(registryPath, "utf-8");
    const regAfter = JSON.parse(rawAfter);
    assert.equal(regAfter.workspaces[canonicalWs].operatingMode, "discussion");
    assert.equal(regAfter.workspaces[canonicalWs].tweakScope, undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PreToolUseHook: stealth manifest denies write even when in Tweak mode", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-stealth-tweak-"));
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "hook-stealth-ws-"));
  try {
    const statePath = path.join(tmpWs, ".ai", "state.json");
    const stealthDir = path.join(tmpWs, ".ai", "stealth");
    await fs.mkdir(stealthDir, { recursive: true });
    const manifestPath = path.join(stealthDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({ excludePath: path.join(tmpWs, ".git/info/exclude"), files: [] }));

    const hookService = new PreToolUseHookService();
    await hookService.equipWorkspace({
      workspaceRoot: tmpWs,
      sidecarStatePath: statePath,
      userDataPath: tmpDir,
      operatingMode: "tweak",
      authorizationRevision: 1,
      tweakScope: {
        transactionId: "tx-stealth",
        allowedRelativePaths: [".ai/stealth/manifest.json"],
        maxFiles: 3,
        maxLineBudget: 120,
        expiresAtMs: Date.now() + 60000
      }
    });

    // Attempt to modify the stealth manifest in tweak mode
    const decision = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "replace_file_content",
          args: {
            TargetFile: manifestPath,
            ReplacementContent: "{}"
          }
        },
        workspacePaths: [tmpWs]
      },
      {
        userDataPath: tmpDir,
        env: { KINS_COCKPIT_ACTIVE: "1" }
      }
    );

    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /KINS_STEALTH/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(tmpWs, { recursive: true, force: true });
  }
});
