import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();

function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function initializer(source, name) {
  const match = source.match(
    new RegExp(`\\bconst\\s+${name}\\s*=\\s*([\\s\\S]*?);`)
  );
  assert.ok(match, `Missing declaration: ${name}`);
  return match[1];
}

test("packaged ECC and icons resolve from installed resources", () => {
  const source = readSource("src/main/index.ts");
  const installRoot = path.resolve("fixture-installed-app");
  const resourcesPath = path.join(installRoot, "resources");
  const expectedEcc = path.join(resourcesPath, "bundled", "ecc");
  const expectedAssets = path.join(resourcesPath, "assets");

  const context = vm.createContext({
    path,
    __dirname: path.join(resourcesPath, "app.asar", "dist", "src", "main"),
    isPackaged: true,
    projectRoot: installRoot,
    process: { resourcesPath, env: {} },
    app: {
      isPackaged: true,
      getPath: () => path.join(installRoot, "Kin's Cockpit.exe"),
    },
    fs: {
      existsSync: candidate =>
        candidate === expectedEcc ||
        candidate === expectedAssets ||
        candidate === path.join(expectedAssets, "icon.ico"),
    },
  });

  vm.runInContext(
    `const resourcesPath = process.resourcesPath; const bundledEccPath = (${initializer(source, "bundledEccPath")});`,
    context
  );

  const ecc = vm.runInContext(
    `(${initializer(source, "eccCatalogPath")})`,
    context
  );
  const assets = vm.runInContext(
    `(${initializer(source, "assetsDir")})`,
    context
  );

  assert.deepEqual(
    { ecc, assets },
    { ecc: expectedEcc, assets: expectedAssets }
  );
});

test("default MCP directories include packaged schemas with unrelated CWD", () => {
  const source = readSource("src/main/services/McpMonitorService.ts");
  const match = source.match(
    /globalMcpDirs:\s*string\[\]\s*=\s*(\[[\s\S]*?\])/
  );
  assert.ok(match, "Missing globalMcpDirs default");

  const resourcesPath = path.resolve("fixture-installed-app", "resources");
  const expected = path.join(resourcesPath, "bundled", "mcp-schemas");
  const directories = vm.runInNewContext(`(${match[1]})`, {
    path,
    process: {
      resourcesPath,
      cwd: () => path.resolve("unrelated-launch-directory"),
      env: {
        USERPROFILE: path.resolve("fixture-user"),
        HOME: path.resolve("fixture-user"),
      },
    },
  });

  assert.ok(
    Array.from(directories).includes(expected),
    `Packaged schema directory absent: ${JSON.stringify(directories)}`
  );
});

test("missing bundle inputs fail without changing orchestration state", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-bundle-"));

  try {
    const project = path.join(fixture, "project");
    const home = path.join(fixture, "empty-home");
    fs.mkdirSync(path.join(project, ".ai"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    const statePath = path.join(project, ".ai", "state.json");
    const originalState = JSON.stringify({
      currentPhase: "REALITY_CHECK",
      qualityRemediation: 1,
    });
    fs.writeFileSync(statePath, originalState, "utf8");

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "bundle-all.mjs")],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
        encoding: "utf8",
        timeout: 180_000,
      }
    );

    assert.ifError(result.error);
    assert.deepEqual(
      {
        failed: result.status !== null && result.status !== 0,
        stateUnchanged:
          fs.readFileSync(statePath, "utf8") === originalState,
      },
      {
        failed: true,
        stateUnchanged: true,
      },
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
