import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { computeRegistryEntryHmac } from "../src/main/services/preToolUseRegistryHmac.js";
import { PreToolUseHookService } from "../src/main/services/preToolUseHookService.js";
import { evaluatePreToolUseHook } from "../src/cli/preToolUseHook.js";

test("registry HMAC authenticates every Tweak authorization field", () => {
  const signingKey = Buffer.alloc(32, 0x37);
  const entry = {
    canonicalWorkspacePath: "/workspace/project",
    sidecarStatePath: "/userdata/project/state.json",
    schemaVersion: 2 as const,
    mutationPolicyMode: "strict" as const,
    operatingMode: "tweak" as const,
    authorizationRevision: 7,
    tweakScope: {
      transactionId: "transaction-original",
      allowedRelativePaths: ["src/approved.ts"],
      maxFiles: 3,
      maxLineBudget: 120,
      expiresAtMs: 2_000_000_000_000
    }
  };

  const originalHmac = computeRegistryEntryHmac(entry, signingKey);
  const alteredScopes = [
    {
      ...entry.tweakScope,
      transactionId: "transaction-replayed"
    },
    {
      ...entry.tweakScope,
      allowedRelativePaths: ["src/unapproved.ts"]
    },
    {
      ...entry.tweakScope,
      maxFiles: 4
    },
    {
      ...entry.tweakScope,
      maxLineBudget: 121
    },
    {
      ...entry.tweakScope,
      expiresAtMs: entry.tweakScope.expiresAtMs + 60_000
    }
  ];

  for (const scope of alteredScopes) {
    const alteredEntry = { ...entry, tweakScope: scope };
    assert.notEqual(
      computeRegistryEntryHmac(alteredEntry, signingKey),
      originalHmac,
      `Scope alteration must invalidate the signature: ${JSON.stringify(scope)}`
    );
  }
});

test("Tweak denies an approved-file replacement exceeding 120 lines", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "operating-mode-budget-")
  );
  const workspaceRoot = path.join(root, "workspace");
  const userDataPath = path.join(root, "userdata");
  const targetFile = path.join(workspaceRoot, "src", "approved.ts");

  try {
    await fs.mkdir(path.dirname(targetFile), { recursive: true });
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(targetFile, "export const original = 0;\n");

    await PreToolUseHookService.getOrCreateSigningKey(userDataPath);

    const hookService = new PreToolUseHookService();
    await hookService.equipWorkspace({
      workspaceRoot,
      sidecarStatePath: path.join(userDataPath, "state.json"),
      userDataPath,
      operatingMode: "tweak",
      authorizationRevision: 1,
      tweakScope: {
        transactionId: "transaction-line-budget",
        allowedRelativePaths: ["src/approved.ts"],
        maxFiles: 3,
        maxLineBudget: 120,
        expiresAtMs: Date.now() + 60_000
      }
    });

    const replacement = Array.from(
      { length: 121 },
      (_, index) => `export const added${index} = ${index};`
    ).join("\n") + "\n";

    const decision = await evaluatePreToolUseHook(
      {
        toolCall: {
          name: "replace_file_content",
          args: {
            TargetFile: targetFile,
            ReplacementContent: replacement
          }
        },
        workspacePaths: [workspaceRoot]
      },
      {
        userDataPath,
        env: { KINS_COCKPIT_ACTIVE: "1" }
      }
    );

    assert.equal(
      decision.decision,
      "deny",
      "An approved path does not authorize exceeding the transaction line budget"
    );
    assert.equal(
      await fs.readFile(targetFile, "utf8"),
      "export const original = 0;\n"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
