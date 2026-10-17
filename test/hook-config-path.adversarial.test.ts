import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { buildSanitizedPtyEnv } from "../src/main/services/PtyService.js";

test("POSIX Cockpit hook config matches the user-data installation path with deep sidecar layout", () => {
  const userDataPath = "/tmp/Kin Cockpit/user-data";
  const sidecarDirectory = `${userDataPath}/workspaces/0123456789abcdef/sidecar`;

  const env = buildSanitizedPtyEnv({}, {
    id: "0123456789abcdef",
    root: "/tmp/project",
    displayName: "project",
    sidecarDirectory,
    rules: []
  });

  assert.equal(
    env["ANTIGRAVITY_HOOKS_CONFIG_PATH"]?.replace(/\\/g, "/"),
    `${userDataPath}/hooks/hooks.json`
  );
});

test("Windows Cockpit hook config matches the user-data installation path with deep sidecar layout", () => {
  const userDataPath = "C:\\Users\\Jane Doe\\AppData\\Roaming\\kins-cockpit";
  const sidecarDirectory = `${userDataPath}\\workspaces\\0123456789abcdef\\sidecar`;

  const env = buildSanitizedPtyEnv({}, {
    id: "0123456789abcdef",
    root: "C:\\Projects\\my-project",
    displayName: "my-project",
    sidecarDirectory,
    rules: []
  });

  assert.equal(
    env["ANTIGRAVITY_HOOKS_CONFIG_PATH"],
    `${userDataPath}\\hooks\\hooks.json`
  );
});
