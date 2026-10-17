import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceUrl = new URL(
  "../src/main/services/McpMonitorService.ts",
  import.meta.url,
);
const sourceText = fs.readFileSync(sourceUrl, "utf8");
const sourceFile = ts.createSourceFile(
  fileURLToPath(sourceUrl),
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

let provisionMethod;
function findMethod(node) {
  if (
    ts.isClassDeclaration(node) &&
    node.name?.text === "McpMonitorService"
  ) {
    provisionMethod = node.members.find(
      (member) =>
        ts.isMethodDeclaration(member) &&
        member.name?.getText(sourceFile) === "provisionExecutionConfigs",
    );
  }
  ts.forEachChild(node, findMethod);
}
findMethod(sourceFile);
assert.ok(provisionMethod, "Expected production provisioning method");

const methodText = provisionMethod
  .getText(sourceFile)
  .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href));

const harnessCode = ts.transpileModule(
  `class Harness {
    ${methodText}
  }
  globalThis.Harness = Harness;`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

function createFixture(t, filesystemOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const configPath = path.join(home, ".gemini", "config", "mcp_config.json");
  const serverPath = path.join(
    projectRoot,
    "resources",
    "bundled",
    "mcp-servers",
    "gpt_architect",
    "server.py",
  );

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  fs.writeFileSync(serverPath, "# provisioning test fixture\n");

  const context = vm.createContext({
    fs: { ...fs, ...filesystemOverrides },
    path,
    fileURLToPath,
    process: {
      env: { HOME: home, USERPROFILE: home },
      platform: process.platform,
    },
    console: { warn() {} },
  });

  vm.runInContext(harnessCode, context);
  const service = new context.Harness();
  service.projectRoot = projectRoot;

  return { service, configPath };
}

test("preserves unrelated settings when mcpServers is absent", (t) => {
  const { service, configPath } = createFixture(t);
  const existing = {
    preferences: { theme: "dark" },
    telemetryEnabled: false,
  };
  fs.writeFileSync(configPath, JSON.stringify(existing));

  service.provisionExecutionConfigs();

  const actual = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(actual.preferences, existing.preferences);
  assert.equal(actual.telemetryEnabled, false);
  assert.ok(actual.mcpServers.gpt_architect);
});

test("does not overwrite an existing malformed configuration", (t) => {
  const { service, configPath } = createFixture(t);
  const original = Buffer.from(
    '{"mcpServers":{"third-party":{"command":"keep-me"}}',
  );
  fs.writeFileSync(configPath, original);

  service.provisionExecutionConfigs();

  assert.deepEqual(
    fs.readFileSync(configPath),
    original,
    "Malformed configuration must remain byte-for-byte recoverable",
  );
});

test("failed atomic replacement never falls back to direct overwrite", (t) => {
  let copyCalls = 0;
  const { service, configPath } = createFixture(t, {
    renameSync() {
      throw Object.assign(new Error("Injected replacement failure"), {
        code: "EACCES",
      });
    },
    copyFileSync(...args) {
      copyCalls += 1;
      return fs.copyFileSync(...args);
    },
  });

  const original = Buffer.from(
    JSON.stringify({
      mcpServers: {
        "third-party": {
          command: "existing-server",
          args: ["--preserve"],
        },
      },
    }),
  );
  fs.writeFileSync(configPath, original);

  service.provisionExecutionConfigs();

  assert.equal(copyCalls, 0, "Direct-copy fallback is not atomic");
  assert.deepEqual(fs.readFileSync(configPath), original);
  assert.deepEqual(
    fs.readdirSync(path.dirname(configPath)).filter(
      (name) => name.endsWith(".tmp"),
    ),
    [],
    "Failed replacement must clean up its temporary file",
  );
});
