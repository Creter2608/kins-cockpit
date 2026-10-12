import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("readiness service does not bypass the execution contract with as any", () => {
  const source = readFileSync(
    path.resolve("src/main/services/SystemReadinessService.ts"),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /\bas\s+any\b/,
    "SystemReadinessService must not contain an unsafe as any cast"
  );
});

test("readiness service remains within the 500-line AQI module ceiling", () => {
  const source = readFileSync(
    path.resolve("src/main/services/SystemReadinessService.ts"),
    "utf8"
  );

  // A final newline terminates the last line; it is not an additional line.
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();

  assert.ok(
    lines.length <= 500,
    `SystemReadinessService has ${lines.length} lines; maximum is 500`
  );
});

test("the displayed installer disclosure names CodeGraph AST Engine", () => {
  const pkg = JSON.parse(
    readFileSync(path.resolve("package.json"), "utf8")
  );

  assert.equal(
    typeof pkg.build?.nsis?.include,
    "string",
    "An NSIS disclosure include must be configured"
  );

  const source = readFileSync(
    path.resolve(pkg.build.nsis.include),
    "utf8"
  );

  const customInit = source.match(
    /!macro\s+customInit\b([\s\S]*?)!macroend/i
  );
  assert.ok(customInit, "customInit disclosure macro must exist");

  const message = customInit[1].match(
    /\bMessageBox\b[^"]*"([^"]*)"/i
  );
  assert.ok(message, "customInit must contain the disclosure MessageBox");

  assert.match(
    message[1],
    /\bCodeGraph AST Engine\b/,
    "The displayed disclosure must name CodeGraph AST Engine"
  );
});
