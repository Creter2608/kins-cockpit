import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSanitizedPtyEnv, ALLOWED_ENV_VARS } from "../src/main/services/PtyService.js";
import { resolveHarnessResourcePaths } from "../src/main/services/harnessResourcePaths.js";

// Golden Assertion 1: {"in":"Windows Path + NVM variables","out":"Single PATH; NVM preserved"}
test("PtyService: preserves NVM_HOME and NVM_SYMLINK and emits single PATH without admitting NODE_PATH", () => {
  const mockEnv: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\System32;C:\\nvm4w\\nodejs",
    Path: "C:\\Windows\\System32;C:\\nvm4w\\nodejs",
    NVM_HOME: "C:\\Users\\Kin\\AppData\\Local\\nvm",
    NVM_SYMLINK: "C:\\nvm4w\\nodejs",
    NODE_PATH: "C:\\unsafe\\node_modules",
    SECRET_KEY: "super-secret-key-12345",
    USERPROFILE: "C:\\Users\\Kin"
  };

  const sanitized = buildSanitizedPtyEnv(mockEnv);

  assert.equal(sanitized["NVM_HOME"], "C:\\Users\\Kin\\AppData\\Local\\nvm");
  assert.equal(sanitized["NVM_SYMLINK"], "C:\\nvm4w\\nodejs");
  assert.equal(sanitized["PATH"], "C:\\Windows\\System32;C:\\nvm4w\\nodejs");
  assert.equal(sanitized["NODE_PATH"], undefined, "NODE_PATH must not be admitted to child PTY");
  assert.equal(sanitized["SECRET_KEY"], undefined);
  assert.equal(sanitized["COLORTERM"], "truecolor");
  assert.equal(sanitized["TERM"], "xterm-256color");

  // ALLOWED_ENV_VARS must strictly contain NVM variables without NODE_PATH (Remediation F-02)
  assert.ok(ALLOWED_ENV_VARS.has("NVM_HOME"), "NVM_HOME must be preserved");
  assert.ok(ALLOWED_ENV_VARS.has("NVM_SYMLINK"), "NVM_SYMLINK must be preserved");
  assert.equal(ALLOWED_ENV_VARS.has("NODE_PATH"), false, "NODE_PATH must not be in allowlist");
});

// Golden Assertion 2: {"in":"Packaged scripts; unrelated CWD","out":"Physical imports succeed outside ASAR"}
test("harnessResourcePaths: resolves app.asar.unpacked/scripts in packaged mode", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-test-"));
  const unpackedScripts = path.join(tempDir, "app.asar.unpacked", "scripts");
  fs.mkdirSync(unpackedScripts, { recursive: true });
  fs.writeFileSync(path.join(unpackedScripts, "ai-loop.mjs"), "// loop script", "utf-8");

  try {
    const resolved = resolveHarnessResourcePaths({
      isPackaged: true,
      resourcesPath: tempDir
    });

    assert.equal(resolved.scriptsDirectory, unpackedScripts);
    assert.equal(resolved.loopScriptPath, path.join(unpackedScripts, "ai-loop.mjs"));
    assert.equal(resolved.aqiHarnessPath, path.join(unpackedScripts, "harness", "aqi.mjs"));
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

// Golden Assertion 3: {"in":"package.json packaging configuration","out":"includes scripts in files and asarUnpack"}
test("package.json: packaging configuration explicitly unpacks production dependency tree (Remediation F-01)", () => {
  const pkgContent = fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8");
  const pkg = JSON.parse(pkgContent);

  const files = pkg.build?.files;
  assert.ok(Array.isArray(files));
  assert.ok(files.includes("scripts/**/*"), "scripts/**/* must be included in build.files");
  assert.ok(files.includes("dist/**/*"), "dist/**/* must be included in build.files");

  const asarUnpack = pkg.build?.asarUnpack;
  assert.ok(Array.isArray(asarUnpack));
  assert.ok(asarUnpack.includes("dist/**/*"), "Missing required unpack pattern: dist/**/*");
  assert.ok(asarUnpack.includes("scripts/**/*"), "Missing required unpack pattern: scripts/**/*");
  assert.ok(asarUnpack.includes("package.json"), "Missing required unpack pattern: package.json");
  assert.ok(asarUnpack.includes("node_modules/**/*"), "Missing required unpack pattern: node_modules/**/*");
});
