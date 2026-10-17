import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourcePath = fileURLToPath(
  new URL("../src/main/services/McpMonitorService.ts", import.meta.url)
);
const source = fs.readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

let methodBody;
function visit(node) {
  if (
    ts.isClassDeclaration(node) &&
    node.name?.text === "McpMonitorService"
  ) {
    const method = node.members.find(
      member =>
        ts.isMethodDeclaration(member) &&
        member.name.getText(ast) === "provisionExecutionConfigs"
    );
    if (method?.body) methodBody = method.body.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(methodBody, "Expected the runtime provisioning method to exist");

function fixture(t, {
  platform = "linux",
  externalProject = false,
  bundleAtProject = true,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const app = path.join(root, "app");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const projectRoot = externalProject
    ? path.join(root, "external-project")
    : app;

  for (const directory of [app, home, bin, projectRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const serverRelative = path.join(
    "resources", "bundled", "mcp-servers", "gpt_architect", "server.py"
  );
  const appServer = path.join(app, serverRelative);
  fs.mkdirSync(path.dirname(appServer), { recursive: true });
  fs.writeFileSync(appServer, "# fixture\n");

  if (bundleAtProject && projectRoot !== app) {
    const projectServer = path.join(projectRoot, serverRelative);
    fs.mkdirSync(path.dirname(projectServer), { recursive: true });
    fs.writeFileSync(projectServer, "# fixture\n");
  }

  const configPath = path.join(
    home, ".gemini", "config", "mcp_config.json"
  );
  const messages = [];
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    PATHEXT: ".EXE;.CMD;.BAT",
  };

  const runtimeUrl = pathToFileURL(
    path.join(app, "dist", "src", "main", "services", "McpMonitorService.js")
  ).href;

  const executableBody = methodBody.replaceAll(
    "import.meta.url",
    JSON.stringify(runtimeUrl)
  );
  const compiled = ts.transpileModule(
    `const provision = function () ${executableBody}; provision;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    }
  ).outputText;

  const provision = vm.runInNewContext(compiled, {
    fs,
    path,
    fileURLToPath,
    process: { env, platform },
    console: {
      warn: (...args) => messages.push(args.map(String).join(" ")),
      error: (...args) => messages.push(args.map(String).join(" ")),
      info: (...args) => messages.push(args.map(String).join(" ")),
      log: (...args) => messages.push(args.map(String).join(" ")),
    },
  });

  return {
    appServer,
    bin,
    configPath,
    messages,
    run: () => provision.call({ projectRoot }),
    readConfig: () => JSON.parse(fs.readFileSync(configPath, "utf8")),
  };
}

test("Windows with only py available uses command py and a separate -3 argument", t => {
  const f = fixture(t, { platform: "win32" });

  // Availability fixture: neither python.exe nor python3.exe exists.
  fs.writeFileSync(path.join(f.bin, "py.exe"), "launcher fixture");
  assert.equal(fs.existsSync(path.join(f.bin, "python.exe")), false);
  assert.equal(fs.existsSync(path.join(f.bin, "python3.exe")), false);

  f.run();

  const entry = f.readConfig().mcpServers.gpt_architect;
  assert.equal(entry.command, "py");
  assert.deepEqual(entry.args, ["-3", f.appServer]);
});

test("missing Python produces actionable installation or PATH guidance", t => {
  const f = fixture(t);

  // This isolated PATH contains no interpreter.
  assert.deepEqual(fs.readdirSync(f.bin), []);
  f.run();

  assert.match(
    f.messages.join("\n"),
    /python[\s\S]*(?:install|PATH|not found|missing|unavailable)/i,
    "Missing Python must produce an actionable developer diagnostic"
  );
});

test("an external project does not hide the application's development bundle", t => {
  const f = fixture(t, {
    externalProject: true,
    bundleAtProject: false,
  });

  // A discoverable Python fixture keeps interpreter availability independent
  // of application-resource discovery.
  const interpreter = path.join(f.bin, "python3");
  fs.writeFileSync(
    interpreter,
    "#!/bin/sh\nprintf 'Python 3.12.0\\n'\n",
    { mode: 0o755 }
  );

  f.run();

  assert.equal(
    fs.existsSync(f.configPath),
    true,
    "Provisioning must find the application bundle outside projectRoot"
  );
  const entry = f.readConfig().mcpServers.gpt_architect;
  assert.ok(entry, "Expected the bundled architect server to be provisioned");
  assert.equal(entry.args.at(-1), f.appServer);
});
