/**
 * test/readiness-terminal-service.test.ts
 * Unit tests for ReadinessTerminalService and Cockpit agy skip-permissions flag.
 * Includes Stage 4 Adversarial regression coverage.
 */

import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  getPrerequisiteInstallCommand,
  executeReadinessInstallInTerminal,
  WINDOWS_AGY_INSTALL_CMD,
  WINDOWS_CODEGRAPH_INSTALL_CMD
} from "../src/main/services/ReadinessTerminalService.js";
import type { InstallablePrerequisiteId } from "../src/shared/systemReadiness.js";

test("ReadinessTerminalService: Windows installation commands match exact specifications", () => {
  assert.equal(
    WINDOWS_AGY_INSTALL_CMD,
    "irm https://antigravity.google/cli/install.ps1 | iex"
  );
  assert.equal(
    WINDOWS_CODEGRAPH_INSTALL_CMD,
    "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex"
  );

  assert.equal(
    getPrerequisiteInstallCommand("antigravity", "win32"),
    "irm https://antigravity.google/cli/install.ps1 | iex"
  );
  assert.equal(
    getPrerequisiteInstallCommand("codegraph", "win32"),
    "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex"
  );
});

test("ReadinessTerminalService: non-Windows platforms return fallback curl/bash commands", () => {
  assert.equal(
    getPrerequisiteInstallCommand("antigravity", "linux"),
    "curl -fsSL https://antigravity.google/cli/install.sh | bash"
  );
  assert.equal(
    getPrerequisiteInstallCommand("codegraph", "darwin"),
    "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | bash"
  );
});

test("ReadinessTerminalService: unsupported id returns undefined", () => {
  const invalidId = "git" as unknown as InstallablePrerequisiteId;
  assert.equal(getPrerequisiteInstallCommand(invalidId, "win32"), undefined);
});

test("ReadinessTerminalService: executeReadinessInstallInTerminal rejects invalid prerequisite id", async () => {
  const invalidId = "docker" as unknown as InstallablePrerequisiteId;
  await assert.rejects(
    async () => {
      await executeReadinessInstallInTerminal(invalidId, "win32");
    },
    /Unsupported prerequisite ID/
  );
});

test("Stage 4 Adversarial A: installer launch remains pending until the launcher emits spawn", async (t) => {
  const child = new ChildProcess();
  const spawnMock = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();

  let pending: Promise<void> | undefined;

  try {
    let settled = false;
    pending = executeReadinessInstallInTerminal("antigravity", "win32");
    void pending.then(
      () => { settled = true; },
      () => { settled = true; }
    );

    // Flush promise continuations without emitting a spawn event.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(spawnMock.mock.callCount(), 1);
    assert.equal(
      settled,
      false,
      "Creating a ChildProcess object does not establish successful startup"
    );

    child.emit("spawn");
    await pending;
    assert.equal(settled, true);
  } finally {
    child.emit("spawn");
    if (pending) {
      await pending.catch(() => undefined);
    }
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Stage 4 Adversarial B: asynchronous launcher ENOENT rejects instead of reporting success", async (t) => {
  const child = new ChildProcess();
  const spawnMock = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();

  try {
    const pending = executeReadinessInstallInTerminal("codegraph", "win32");
    const rejected = assert.rejects(pending, /ENOENT/);

    queueMicrotask(() => {
      child.emit("error", new Error("spawn powershell.exe ENOENT"));
    });

    await rejected;
    assert.equal(spawnMock.mock.callCount(), 1);
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Stage 4 Adversarial C: unsupported platforms expose no command and never spawn", async (t) => {
  const child = new ChildProcess();
  const spawnMock = t.mock.method(childProcess, "spawn", () => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  syncBuiltinESMExports();

  try {
    for (const id of ["antigravity", "codegraph"] as const) {
      await assert.rejects(
        executeReadinessInstallInTerminal(id, "aix"),
        /unsupported|no .*command|unavailable/i
      );
      assert.equal(getPrerequisiteInstallCommand(id, "aix"), undefined);
    }

    assert.equal(
      spawnMock.mock.callCount(),
      0,
      "Unsupported platforms must be rejected before process creation"
    );
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});
