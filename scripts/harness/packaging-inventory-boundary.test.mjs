import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function rejectsEccInventory(count) {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts", "bundle-all.mjs"),
    "utf8"
  );

  const match = source.match(
    /if\s*\(\s*(eccTotalCount\b[^)]*)\)/
  );

  assert.ok(match, "Missing ECC inventory rejection guard");

  const result = vm.runInNewContext(
    `Boolean(${match[1]})`,
    { eccTotalCount: count },
    { timeout: 1000 }
  );

  assert.equal(typeof result, "boolean");
  return result;
}

test("ECC inventory rejects every count below the declared 794-file minimum", () => {
  for (const count of [0, 789, 790, 791, 792, 793]) {
    assert.equal(
      rejectsEccInventory(count),
      true,
      `Incomplete ECC inventory of ${count} files must be rejected`
    );
  }
});

test("ECC inventory accepts the declared minimum and larger inventories", () => {
  for (const count of [794, 795, 800]) {
    assert.equal(
      rejectsEccInventory(count),
      false,
      `ECC inventory of ${count} files meets the declared minimum`
    );
  }
});
