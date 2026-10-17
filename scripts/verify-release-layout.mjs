#!/usr/bin/env node
/**
 * scripts/verify-release-layout.mjs
 * Validates that physical files required by external Node.js are present in the unpacked release
 * and can be imported directly without Electron ASAR emulation.
 *
 * Usage: node scripts/verify-release-layout.mjs [resources-dir]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const print = (msg) => fs.writeSync(1, `${msg}\n`);
const printErr = (msg) => fs.writeSync(2, `${msg}\n`);

const targetResourcesDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(process.cwd(), "release", "win-unpacked", "resources");

print(`[VERIFY-LAYOUT] Checking unpacked release resources at: ${targetResourcesDir}`);

if (!fs.existsSync(targetResourcesDir)) {
  printErr(`[FAIL] Resources directory not found: ${targetResourcesDir}`);
  process.exit(1);
}

const unpackedRoot = path.join(targetResourcesDir, "app.asar.unpacked");
if (!fs.existsSync(unpackedRoot)) {
  printErr(`[FAIL] app.asar.unpacked directory not found in: ${targetResourcesDir}`);
  process.exit(1);
}

const requiredFiles = [
  path.join(unpackedRoot, "package.json"),
  path.join(unpackedRoot, "dist", "src", "index.js"),
  path.join(unpackedRoot, "dist", "src", "engine.js"),
  path.join(unpackedRoot, "dist", "src", "cli", "preToolUseHook.js"),
  path.join(unpackedRoot, "scripts", "ai-loop.mjs"),
  path.join(unpackedRoot, "scripts", "harness", "runner.mjs")
];

let missingCount = 0;
for (const reqFile of requiredFiles) {
  if (!fs.existsSync(reqFile)) {
    printErr(`[FAIL] Required unpacked file missing: ${reqFile}`);
    missingCount++;
  } else {
    print(`[OK] Present: ${path.relative(unpackedRoot, reqFile)}`);
  }
}

if (missingCount > 0) {
  printErr(`[FAIL] Release layout verification failed: ${missingCount} required files missing.`);
  process.exit(1);
}

// Smoke test dynamic import of unpacked entry point
const indexJs = path.join(unpackedRoot, "dist", "src", "index.js");
try {
  const mod = await import(pathToFileURL(indexJs).href);
  if (!mod.LoopEngine) {
    printErr("[FAIL] Imported module dist/src/index.js is missing expected LoopEngine export.");
    process.exit(1);
  }
  print("[OK] External Node successfully imported unpacked dist/src/index.js.");
} catch (err) {
  printErr(`[FAIL] Failed to import unpacked dist/src/index.js: ${err.message}`);
  process.exit(1);
}

print("[SUCCESS] Release layout verification passed completely!");
process.exit(0);
