import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const filename = path.resolve("src/main/services/SystemReadinessService.ts");
const source = fs.readFileSync(filename, "utf8");
const ast = ts.createSourceFile(
  filename,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

function collect(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];

  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }

  visit(root);
  return matches;
}

function codeGraphFailureClassifier(): (input: unknown) => boolean {
  const methods = collect(
    ast,
    (node) =>
      ts.isMethodDeclaration(node) &&
      node.name.getText(ast) === "probeCodeGraph"
  ) as ts.MethodDeclaration[];
  assert.equal(methods.length, 1, "Expected one CodeGraph probe");

  const catches = collect(
    methods[0]!,
    (node) =>
      ts.isCatchClause(node) &&
      node.block.getText(ast).includes("executionFailedOrUnusable")
  ) as ts.CatchClause[];
  assert.equal(catches.length, 1, "Expected the CodeGraph failure catch");

  const clause = catches[0]!;
  assert.ok(clause.variableDeclaration, "Expected a catch variable");

  const binding = clause.variableDeclaration.name.getText(ast);
  const wrapper = `
    function classifyFailure(input: unknown): boolean {
      let executionFailedOrUnusable = false;
      try {
        throw input;
      } catch (${binding}: unknown) ${clause.block.getText(ast)}
      return executionFailedOrUnusable;
    }
  `;

  const compiled = ts.transpileModule(wrapper, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS
    }
  }).outputText;

  return new Function(`${compiled}\nreturn classifyFailure;`)() as (input: unknown) => boolean;
}

test("readiness probes do not enable implicit shell execution", () => {
  const unsafeOptions = collect(
    ast,
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === "shell" &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
  );

  assert.equal(
    unsafeOptions.length,
    0,
    "Invoke the trusted command processor explicitly with quoted arguments"
  );
});

test("EINVAL records execution failure rather than executable absence", () => {
  const classifyFailure = codeGraphFailureClassifier();
  const error = Object.assign(new Error("Invalid executable invocation"), {
    code: "EINVAL"
  });

  assert.equal(
    classifyFailure(error),
    true,
    "Invalid invocation must make unsuccessful probing unavailable"
  );
});

test("application diagnostics cannot turn nonzero exits into missing", () => {
  const classifyFailure = codeGraphFailureClassifier();

  const errors = [
    Object.assign(new Error("CodeGraph exited unsuccessfully"), {
      code: 1,
      stderr: "cannot find configuration file"
    }),
    Object.assign(new Error("option not recognized"), {
      code: 2,
      stderr: ""
    })
  ];

  for (const error of errors) {
    assert.equal(
      classifyFailure(error),
      true,
      "An application failure must remain an execution failure"
    );
  }
});
