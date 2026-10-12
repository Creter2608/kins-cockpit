import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { resolveDefaultUserDataPath } from "../src/cli/preToolUseHookHelpers.js";
import { resolveLoopStatePath } from "../src/main/services/LoopStateService.js";

test("user-data-branding: manifest and lockfile have new kins-cockpit identity", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf-8"));

  assert.equal(pkg.name, "kins-cockpit");
  assert.equal(pkg.productName, "Kin's Cockpit");
  assert.equal(lock.name, "kins-cockpit");
  if (lock.packages && lock.packages[""]) {
    assert.equal(lock.packages[""].name, "kins-cockpit");
  }
});

test("user-data-branding: explicit ANTIGRAVITY_HOOK_USER_DATA override retains highest precedence", () => {
  const custom = path.resolve("some/custom/user/data");
  const resolved = resolveDefaultUserDataPath({ ANTIGRAVITY_HOOK_USER_DATA: custom });
  assert.equal(resolved, custom);
});

test("user-data-branding: selects fallback when neither directory exists without mutating disk", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-branding-test-"));
  try {
    const env = { APPDATA: tempDir, XDG_CONFIG_HOME: tempDir, USERPROFILE: tempDir, HOME: tempDir };
    const resolved = resolveDefaultUserDataPath(env as unknown as NodeJS.ProcessEnv);
    // Does not mutate filesystem
    assert.equal(fs.existsSync(path.join(tempDir, "kins-cockpit")), false);
    assert.equal(fs.existsSync(path.join(tempDir, "kins-multiagents-ui")), false);
    assert.equal(resolved, path.join(os.homedir(), ".gemini", "antigravity-cli", "userData"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("user-data-branding: selects legacy kins-multiagents-ui when legacy registry exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-branding-legacy-"));
  try {
    const legacyDir = path.join(tempDir, "kins-multiagents-ui");
    const hooksDir = path.join(legacyDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "workspaces.json"), "{}", "utf-8");

    const env = { APPDATA: tempDir, XDG_CONFIG_HOME: tempDir, USERPROFILE: tempDir, HOME: tempDir };
    const resolved = resolveDefaultUserDataPath(env as unknown as NodeJS.ProcessEnv);
    assert.equal(resolved, legacyDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("user-data-branding: selects new kins-cockpit when both directories exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-branding-both-"));
  try {
    const newDir = path.join(tempDir, "kins-cockpit");
    const newHooksDir = path.join(newDir, "hooks");
    fs.mkdirSync(newHooksDir, { recursive: true });
    fs.writeFileSync(path.join(newHooksDir, "workspaces.json"), "{}", "utf-8");

    const legacyDir = path.join(tempDir, "kins-multiagents-ui");
    const legacyHooksDir = path.join(legacyDir, "hooks");
    fs.mkdirSync(legacyHooksDir, { recursive: true });
    fs.writeFileSync(path.join(legacyHooksDir, "workspaces.json"), "{}", "utf-8");

    const env = { APPDATA: tempDir, XDG_CONFIG_HOME: tempDir, USERPROFILE: tempDir, HOME: tempDir };
    const resolved = resolveDefaultUserDataPath(env as unknown as NodeJS.ProcessEnv);
    assert.equal(resolved, newDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("LoopStateService: resolveLoopStatePath fallback and backward compatibility", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kins-loop-state-test-"));
  const prevAppData = process.env.APPDATA;
  try {
    process.env.APPDATA = tempDir;
    const fakeRepo = path.join(tempDir, "foreign-repo");
    fs.mkdirSync(fakeRepo, { recursive: true });
    const safeId = crypto.createHash("sha256").update(path.resolve(fakeRepo)).digest("hex").slice(0, 16);

    const prospectiveCockpit = path.join(tempDir, "kins-cockpit", "workspaces", safeId, "sidecar", "state", "state.json");
    const legacyState = path.join(tempDir, "kins-multiagents-ui", "workspaces", safeId, "sidecar", "state", "state.json");

    // Case 1: Neither exists -> prospective kins-cockpit path
    const resolvedNone = resolveLoopStatePath(fakeRepo);
    assert.equal(resolvedNone, prospectiveCockpit);

    // Case 2: Only legacy exists -> returns legacyState
    fs.mkdirSync(path.dirname(legacyState), { recursive: true });
    fs.writeFileSync(legacyState, JSON.stringify({ runId: "legacy-run" }), "utf-8");
    const resolvedLegacy = resolveLoopStatePath(fakeRepo);
    assert.equal(resolvedLegacy, legacyState);

    // Case 3: Both exist -> returns prospectiveCockpit
    fs.mkdirSync(path.dirname(prospectiveCockpit), { recursive: true });
    fs.writeFileSync(prospectiveCockpit, JSON.stringify({ runId: "cockpit-run" }), "utf-8");
    const resolvedBoth = resolveLoopStatePath(fakeRepo);
    assert.equal(resolvedBoth, prospectiveCockpit);
  } finally {
    if (prevAppData !== undefined) {
      process.env.APPDATA = prevAppData;
    } else {
      delete process.env.APPDATA;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
