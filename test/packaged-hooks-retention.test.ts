/**
 * test/packaged-hooks-retention.test.ts
 * Verifies Golden Assertion 5:
 * "packaged CLI hook -> CLI unpacked in asarUnpack; no MODULE_NOT_FOUND"
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("Golden Assertion 5: package.json asarUnpack retains dist/src/cli/**/*", () => {
  const pkgRaw = fs.readFileSync(path.resolve("package.json"), "utf-8");
  const pkg = JSON.parse(pkgRaw);

  const asarUnpack = pkg.build?.asarUnpack;
  assert.ok(Array.isArray(asarUnpack), "build.asarUnpack must be configured as an array");
  assert.ok(
    asarUnpack.includes("dist/src/cli/**/*"),
    "build.asarUnpack must retain dist/src/cli/**/* to allow external node execution of preToolUseHook"
  );
  assert.ok(
    asarUnpack.some((p: string) => p.includes("node-pty")),
    "build.asarUnpack must retain node-pty native bindings"
  );
});
