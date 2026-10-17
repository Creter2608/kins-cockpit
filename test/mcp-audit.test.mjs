import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpMonitorService } from
  "../dist/src/main/services/McpMonitorService.js";

const missingPythonWarning =
  "[McpMonitorService] Python 3 runtime not found in PATH; " +
  "gpt_architect will fail to launch until Python is installed " +
  "and available in PATH";

function withProvisioningFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-audit-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const configPath = path.join(
    home, ".gemini", "config", "mcp_config.json"
  );
  const serverPath = path.join(
    root, "resources", "bundled", "mcp-servers",
    "gpt_architect", "server.py"
  );

  const savedEnv = new Map(
    ["HOME", "USERPROFILE", "PATH"].map(
      key => [key, process.env[key]]
    )
  );
  const originalWarn = console.warn;
  const warnings = [];

  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(serverPath, "pass\n");

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = bin;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(" "));
    };

    const service = Object.create(McpMonitorService.prototype);
    service.projectRoot = root;

    return run({
      service,
      bin,
      configPath,
      warnings,
      readConfig() {
        return JSON.parse(fs.readFileSync(configPath, "utf8"));
      }
    });
  } finally {
    console.warn = originalWarn;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  "Python 2 named python does not satisfy Python 3 discovery",
  { skip: process.platform === "win32", concurrency: false },
  () => {
    withProvisioningFixture(
      ({ service, bin, warnings, readConfig }) => {
        const executable = path.join(bin, "python");
        fs.writeFileSync(
          executable,
          "#!/bin/sh\nprintf 'Python 2.7.18\\n'\nexit 0\n",
          { mode: 0o755 }
        );

        service.provisionExecutionConfigs();

        assert.ok(
          warnings.includes(missingPythonWarning),
          "Python 2 must trigger the missing-Python-3 warning"
        );
        assert.equal(
          readConfig().mcpServers.gpt_architect.command,
          "python3",
          "Missing Python 3 must provision the POSIX fallback"
        );
      }
    );
  }
);

test(
  "a non-executable python3 file does not suppress the runtime warning",
  { skip: process.platform === "win32", concurrency: false },
  () => {
    withProvisioningFixture(
      ({ service, bin, warnings, readConfig }) => {
        const executable = path.join(bin, "python3");
        fs.writeFileSync(
          executable,
          "#!/bin/sh\nprintf 'Python 3.12.0\\n'\n",
          { mode: 0o644 }
        );
        fs.chmodSync(executable, 0o644);

        assert.throws(
          () => fs.accessSync(executable, fs.constants.X_OK),
          "Fixture must not be executable"
        );

        service.provisionExecutionConfigs();

        assert.ok(
          warnings.includes(missingPythonWarning),
          "An existing but unusable file is not a Python 3 runtime"
        );
        assert.equal(
          readConfig().mcpServers.gpt_architect.command,
          "python3"
        );
      }
    );
  }
);

test(
  "an intervening configuration update is not silently overwritten",
  { concurrency: false },
  () => {
    withProvisioningFixture(
      ({ service, configPath, readConfig }) => {
        const initial = {
          theme: "dark",
          mcpServers: {
            existing: { command: "existing-command", args: [] }
          }
        };
        fs.writeFileSync(configPath, JSON.stringify(initial));

        const originalWrite = fs.writeFileSync;
        let injected = false;

        fs.writeFileSync = function (file, ...args) {
          const result = originalWrite.call(this, file, ...args);

          // Insert another writer after provisioning has read its
          // snapshot and written its temporary replacement.
          if (
            !injected &&
            typeof file === "string" &&
            file.startsWith(`${configPath}.`) &&
            file.endsWith(".tmp")
          ) {
            injected = true;
            const latest = JSON.parse(
              fs.readFileSync(configPath, "utf8")
            );
            latest.mcpServers.concurrent = {
              command: "concurrent-command",
              args: ["--keep"]
            };
            originalWrite.call(
              fs,
              configPath,
              JSON.stringify(latest)
            );
          }

          return result;
        };

        try {
          service.provisionExecutionConfigs();
        } finally {
          fs.writeFileSync = originalWrite;
        }

        assert.equal(
          injected,
          true,
          "The concurrent-write boundary must be exercised"
        );
        const actual = readConfig();
        assert.equal(actual.theme, "dark");
        assert.deepEqual(
          actual.mcpServers.existing,
          initial.mcpServers.existing
        );
        assert.deepEqual(
          actual.mcpServers.concurrent,
          {
            command: "concurrent-command",
            args: ["--keep"]
          },
          "Provisioning must preserve the intervening update"
        );
      }
    );
  }
);
