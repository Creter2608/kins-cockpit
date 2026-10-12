import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

test("assisted NSIS installer connects an existing prerequisite include", () => {
  const root = process.cwd();
  const pkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  const nsis = pkg.build?.nsis;

  assert.ok(nsis, "electron-builder NSIS configuration must exist");
  assert.equal(nsis.oneClick, false);
  assert.equal(nsis.perMachine, false);
  assert.equal(nsis.allowToChangeInstallationDirectory, true);
  assert.equal(nsis.shortcutName, "Kin's Cockpit");

  assert.equal(
    typeof nsis.include,
    "string",
    "The required disclosure hook must be connected through nsis.include"
  );
  assert.ok(nsis.include.trim().length > 0);

  const includePath = path.resolve(root, nsis.include);
  assert.equal(
    statSync(includePath).isFile(),
    true,
    "The configured NSIS include must exist as a file"
  );
});

test("configured NSIS include identifies all prerequisite dependencies", () => {
  const root = process.cwd();
  const pkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  const include = pkg.build?.nsis?.include;

  assert.equal(
    typeof include,
    "string",
    "Cannot disclose prerequisites without a configured installer include"
  );

  const source = readFileSync(path.resolve(root, include), "utf8");

  assert.match(source, /\bGit\b/i, "Git disclosure is missing");
  assert.match(source, /\bNode(?:\.js)?\b/i, "Node.js disclosure is missing");
  assert.match(source, /\b22\b/, "Minimum external Node.js major is missing");
  assert.match(source, /\bDocker\b/i, "Docker disclosure is missing");
  assert.match(
    source,
    /\bkins_autonomous_sandbox\b/,
    "The exact sandbox container identity must be disclosed"
  );
  assert.match(
    source,
    /\bAntigravity\b/i,
    "Antigravity CLI disclosure is missing"
  );
  assert.match(
    source,
    /\bManifestDPIAware\s+true\b/i,
    "ManifestDPIAware true directive must be declared"
  );
  assert.match(
    source,
    /\bCodeGraph\b/i,
    "CodeGraph CLI disclosure is missing"
  );
});
