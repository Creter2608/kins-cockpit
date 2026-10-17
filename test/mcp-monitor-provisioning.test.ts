import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpMonitorService } from "../src/main/services/McpMonitorService.js";

test("McpMonitorService: provisionBundledSchemas synchronizes schemas to target directory", () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-prov-proj-"));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-prov-home-"));

  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;

  try {
    // 1. Setup mock bundled schemas in project
    const bundledDir = path.join(tempProject, "resources", "bundled", "mcp-schemas");
    const sampleServerDir = path.join(bundledDir, "test-server");
    fs.mkdirSync(sampleServerDir, { recursive: true });
    fs.writeFileSync(path.join(sampleServerDir, "test_tool.json"), JSON.stringify({ name: "test_tool" }), "utf-8");

    // 2. Set environment home to tempHome
    process.env.USERPROFILE = tempHome;
    process.env.HOME = tempHome;

    const monitor = new McpMonitorService(tempProject, [bundledDir]);
    const targetDir = path.join(tempHome, ".gemini", "antigravity-cli", "mcp", "test-server");
    assert.ok(fs.existsSync(targetDir), "Target server directory should be provisioned");
    assert.ok(fs.existsSync(path.join(targetDir, "test_tool.json")), "Tool schema should be copied to target");

    const snapshot = monitor.getSnapshot();
    assert.ok(snapshot.servers.some((s) => s.name === "test-server"), "Discovered servers should include test-server");
  } finally {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    fs.rmSync(tempProject, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("development Electron resourcesPath must not hide repository schemas", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dev-probe-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const electronResources = path.join(root, "electron-resources");
  const source = path.join(
    project,
    "resources",
    "bundled",
    "mcp-schemas",
    "audit-dev-server"
  );

  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  const oldResources = Object.getOwnPropertyDescriptor(process, "resourcesPath");

  try {
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(electronResources, { recursive: true });
    fs.writeFileSync(
      path.join(source, "audit_tool.json"),
      JSON.stringify({ name: "audit_tool" })
    );

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      writable: true,
      value: electronResources
    });

    new McpMonitorService(project, []);

    const installed = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "mcp",
      "audit-dev-server",
      "audit_tool.json"
    );

    assert.ok(
      fs.existsSync(installed),
      "Development provisioning must find the repository bundle"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(installed, "utf8")).name,
      "audit_tool"
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;

    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;

    if (oldResources) {
      Object.defineProperty(process, "resourcesPath", oldResources);
    } else {
      Reflect.deleteProperty(process, "resourcesPath");
    }

    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed schema copy must not publish partial JSON or change prior files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-atomic-probe-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const resources = path.join(root, "resources");
  const source = path.join(
    project,
    "resources",
    "bundled",
    "mcp-schemas",
    "audit-atomic-server"
  );
  const destination = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "mcp",
    "audit-atomic-server"
  );

  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;

  try {
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });

    const priorFile = path.join(destination, "prior_tool.json");
    const priorContents = JSON.stringify({ name: "prior_tool" });
    fs.writeFileSync(priorFile, priorContents);

    // Corrupted source schema file
    fs.writeFileSync(
      path.join(source, "new_tool.json"),
      '{"name": INVALID_JSON_BODY'
    );

    process.env.HOME = home;
    process.env.USERPROFILE = home;

    new McpMonitorService(project, []);

    assert.equal(fs.readFileSync(priorFile, "utf8"), priorContents);
    assert.equal(
      fs.existsSync(path.join(destination, "new_tool.json")),
      false,
      "An interrupted or invalid copy must not leave a partial published schema"
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;

    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;

    fs.rmSync(root, { recursive: true, force: true });
  }
});
