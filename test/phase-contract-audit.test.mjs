import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadSource(relativePath) {
  const filename = new URL(`../${relativePath}`, import.meta.url);
  return ts.createSourceFile(
    filename.pathname,
    readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function findNode(source, predicate) {
  let result;

  function visit(node) {
    if (result) return;
    if (predicate(node)) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  assert.ok(result, `Expected production predicate in ${source.fileName}`);
  return result;
}

function initializer(source, name) {
  const declaration = findNode(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );

  assert.ok(declaration.initializer, `${name} must have an initializer`);
  return declaration.initializer;
}

function evaluate(source, expression, bindings) {
  return runInNewContext(`(${expression.getText(source)})`, bindings, {
    timeout: 1000,
  });
}

test("PLAN -> EXECUTE rejects missing approval even with write-tool evidence", () => {
  const source = loadSource("src/main/services/loopTransitionGuard.ts");
  const rejectionGate = findNode(
    source,
    (node) =>
      ts.isIfStatement(node) &&
      /\bhasApproval\b/.test(node.expression.getText(source)),
  );

  for (const hasCodeEvidence of [false, true]) {
    assert.equal(
      evaluate(source, rejectionGate.expression, {
        hasApproval: false,
        hasCodeEvidence,
      }),
      true,
      `Missing approval must trigger rejection; hasCodeEvidence=${hasCodeEvidence}`,
    );
  }
});

test("only INITIALIZE and SPEC_GATE qualify as automatic restart signals", () => {
  const source = loadSource("src/main/services/TranscriptIngestionService.ts");
  const expression = initializer(source, "isEarlyPhaseStart");

  const cases = [
    ["INITIALIZE", true],
    ["SPEC_GATE", true],
    ["ISOLATE", false],
    ["DETECT_STACKS", false],
    ["PLAN", false],
    ["EXECUTE", false],
    ["VERIFY", false],
    ["REALITY_CHECK", false],
    ["RELEASE_GATE", false],
    ["COMPLETE", false],
  ];

  for (const [phase, expected] of cases) {
    assert.equal(
      evaluate(source, expression, { detection: { phase } }),
      expected,
      `Unexpected automatic restart eligibility for ${phase}`,
    );
  }
});

test("COMPLETE is completed only when succeeded and displayed as COMPLETE", () => {
  const source = loadSource("src/renderer/components/PhaseTracker.tsx");
  const terminalExpression = initializer(source, "isCompleteTerminal");
  const completedExpression = initializer(source, "isCompleted");

  for (const status of ["failed", "succeeded"]) {
    for (const displayPhase of ["VERIFY", "COMPLETE"]) {
      const bindings = {
        item: { phase: "COMPLETE", status: "completed" },
        loopState: { status },
        displayPhase,
      };

      const isCompleteTerminal = evaluate(
        source,
        terminalExpression,
        bindings,
      );

      assert.equal(
        evaluate(source, completedExpression, {
          ...bindings,
          isCompleteTerminal,
        }),
        status === "succeeded" && displayPhase === "COMPLETE",
        `Invalid COMPLETE completion: status=${status}, displayPhase=${displayPhase}`,
      );
    }
  }
});
