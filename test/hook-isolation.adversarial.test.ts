import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { evaluatePreToolUseHook } from "../src/cli/preToolUseHook.js";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";

test("external sessions pass through regardless of test or configuration hints", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-external-"));

  try {
    const payload = {
      toolCall: {
        name: "write_to_file",
        args: {
          TargetFile: path.join(root, "external-project", "index.ts")
        }
      }
    };

    const cases = [
      {
        name: "NODE_ENV=test is not Cockpit activation",
        env: {
          NODE_ENV: "test",
          KINS_COCKPIT_ACTIVE: "0",
          HOME: root,
          USERPROFILE: root,
          APPDATA: root,
          XDG_CONFIG_HOME: root
        }
      },
      {
        name: "a configuration path is not Cockpit activation",
        env: {
          NODE_ENV: "production",
          KINS_COCKPIT_ACTIVE: "0",
          ANTIGRAVITY_HOOKS_CONFIG_PATH: path.join(root, "hooks", "hooks.json"),
          HOME: root,
          USERPROFILE: root,
          APPDATA: root,
          XDG_CONFIG_HOME: root
        }
      }
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const result = await evaluatePreToolUseHook(payload, {
          env: fixture.env
        });

        assert.equal(result.decision, "allow");
        assert.match(result.reason ?? "", /pass-through/i);
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Cockpit mutation denies divergent states without changing either file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-conflict-"));
  const workspaceRoot = path.join(root, "workspace");
  const userDataPath = path.join(root, "userData");
  const legacyStatePath = path.join(workspaceRoot, ".ai", "state.json");
  const sidecarStatePath = path.join(
    userDataPath,
    "workspaces",
    "workspace-1",
    "state.json"
  );

  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });

    const service = new PreToolUseHookService();
    await service.equipWorkspace({
      workspaceRoot,
      userDataPath,
      sidecarStatePath
    });

    fs.mkdirSync(path.dirname(legacyStatePath), { recursive: true });
    fs.mkdirSync(path.dirname(sidecarStatePath), { recursive: true });

    const legacyContents = JSON.stringify({ runId: "legacy-run" });
    const sidecarContents = JSON.stringify({ runId: "sidecar-run" });

    fs.writeFileSync(legacyStatePath, legacyContents, "utf8");
    fs.writeFileSync(sidecarStatePath, sidecarContents, "utf8");

    const result = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "write_to_file",
          args: {
            TargetFile: path.join(workspaceRoot, "index.ts")
          }
        }
      },
      {
        userDataPath,
        env: {
          NODE_ENV: "production",
          KINS_COCKPIT_ACTIVE: "1"
        }
      }
    );

    assert.equal(result.decision, "deny");
    assert.match(result.reason ?? "", /STATE_PATH_CONFLICT/);
    assert.equal(fs.readFileSync(legacyStatePath, "utf8"), legacyContents);
    assert.equal(fs.readFileSync(sidecarStatePath, "utf8"), sidecarContents);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test runtime uses the same exact userData hook-config path as production", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-config-"));
  const workspaceRoot = path.join(root, "workspace");
  const userDataPath = path.join(root, "userData");
  const previousNodeEnv = process.env.NODE_ENV;

  try {
    process.env.NODE_ENV = "test";
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(userDataPath, { recursive: true });

    const service = new PreToolUseHookService();
    const equipped = await service.equipWorkspace({
      workspaceRoot,
      userDataPath,
      sidecarStatePath: path.join(
        userDataPath,
        "workspaces",
        "workspace-1",
        "state.json"
      )
    });

    const expected = path.join(userDataPath, "hooks", "hooks.json");

    assert.equal(path.resolve(equipped.hooksConfigPath), path.resolve(expected));
    assert.equal(fs.existsSync(expected), true);
    assert.equal(fs.existsSync(path.join(userDataPath, "hooks.json")), false);
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }

    fs.rmSync(root, { recursive: true, force: true });
  }
});
