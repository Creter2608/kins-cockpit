import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { StringDecoder } from "node:string_decoder";

function readSource(relativePath) {
  return fs.readFileSync(
    new URL(`../${relativePath}`, import.meta.url),
    "utf8"
  );
}

// Extracts only the simple, visible branch bodies used by these tests.
// Fail closed if the branch is absent or its layout changes.
function extractBranch(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `Cannot locate ${label}; update the regression guard`);
  return match[1];
}

test("duplicate invocation evidence cannot reopen a terminal identity", () => {
  const source = readSource("src/main/services/SubagentService.ts");
  // Check that terminal state returns early
  assert.match(
    source,
    /if\s*\(\s*existing\.status\s*===\s*["']completed["']\s*\|\|\s*existing\.status\s*===\s*["']error["']\s*\)\s*\{\s*return\s+this\.toActivity\(existing\);?\s*\}/,
    "Terminal records must return early to preserve idempotence"
  );
});

test("truncation discards buffered UTF-8 bytes before replacement records", () => {
  const source = readSource(
    "src/main/services/TranscriptIngestionService.ts"
  );
  const body = extractBranch(
    source,
    /if\s*\(stat\.size\s*<\s*this\.lastOffset\)\s*\{([^{}]*)\}/,
    "processFile truncation branch"
  );

  const state = {
    lastOffset: 4096,
    incompleteLine: '{"old":"',
    discardUntilNewline: false,
    stringDecoder: new StringDecoder("utf-8")
  };

  // Buffer the first two bytes of a three-byte UTF-8 character.
  assert.equal(
    state.stringDecoder.write(Buffer.from([0xe2, 0x82])),
    ""
  );

  vm.runInNewContext(
    `(function () { ${body} }).call(state)`,
    { state, StringDecoder },
    { timeout: 1000 }
  );

  const replacement = '{"type":"replacement"}\n';
  assert.equal(
    state.stringDecoder.write(Buffer.from(replacement, "utf8")),
    replacement
  );
  assert.equal(state.lastOffset, 0);
  assert.equal(state.incompleteLine, "");
  assert.equal(state.discardUntilNewline, false);
});

test("ingestion remediation preserves the existing renderer behavior", () => {
  const app = readSource("src/renderer/App.tsx");
  const terminal = readSource(
    "src/renderer/components/TerminalStage.tsx"
  );

  assert.match(
    app,
    /if\s*\(\s*activities\.some\(\s*\(?a\)?\s*=>\s*a\.status\s*===\s*["']running["']\s*\)\s*\)\s*\{\s*setRightSidebarTab\(["']subagents["']\);?\s*\}/,
    "Restore the existing running-subagent tab-selection behavior"
  );

  assert.match(
    terminal,
    /export const TerminalStage:\s*React\.FC\s*=\s*\(\)\s*=>\s*\{/,
    "Revert the out-of-contract TerminalStage memoization"
  );
});
