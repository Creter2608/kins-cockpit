import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

interface HandlerHarness {
  execute: (id: string, command: string) => Promise<void>;
  launches: string[];
  notices: string[];
  executionStates: Array<string | null>;
}

function loadExecuteHandler(
  writeText: (text: string) => Promise<void>
): HandlerHarness {
  const filePath = path.resolve(
    process.cwd(),
    "src/renderer/components/SystemReadinessModal.tsx"
  );
  const source = readFileSync(filePath, "utf8");
  const ast = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  let callback: ts.ArrowFunction | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "handleExecuteInTerminal" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const argument = node.initializer.arguments[0];
      if (argument && ts.isArrowFunction(argument)) {
        callback = argument;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  assert.ok(callback, "Installation callback must exist");

  const compiled = ts.transpileModule(
    `const auditHandler = ${callback.getText(ast)};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS
      }
    }
  ).outputText;

  const launches: string[] = [];
  const notices: string[] = [];
  const executionStates: Array<string | null> = [];

  const sandbox = {
    executingId: null,
    navigator: { clipboard: { writeText } },
    window: {
      cockpitApi: {
        readiness: {
          executeInTerminal: async (id: string): Promise<void> => {
            launches.push(id);
          }
        }
      }
    },
    setExecutingId: (id: string | null): void => {
      executionStates.push(id);
    },
    setLaunchError: (_message: string | null): void => {},
    setClipboardNotice: (message: string | null): void => {
      if (message !== null) notices.push(message);
    },
    setCopiedId: (_id: string | null): void => {},
    setLaunchedId: (_id: string | null): void => {},
    setTimeout: (_callback: () => void, _delay: number): number => 0,
    Error
  };

  const execute = runInNewContext(
    `${compiled}\nauditHandler;`,
    sandbox
  ) as HandlerHarness["execute"];

  return { execute, launches, notices, executionStates };
}

test(
  "terminal installation does not wait for a pending clipboard permission request",
  async () => {
    let releaseClipboard!: () => void;
    const clipboardPending = new Promise<void>((resolve) => {
      releaseClipboard = resolve;
    });

    const harness = loadExecuteHandler(() => clipboardPending);
    const execution = harness.execute("antigravity", "install-command");

    try {
      // Permit already-scheduled promise continuations without resolving
      // the unrelated clipboard request.
      await Promise.resolve();
      await Promise.resolve();

      assert.deepEqual(
        harness.launches,
        ["antigravity"],
        "Optional clipboard work must not prevent terminal startup"
      );
    } finally {
      releaseClipboard();
      await execution;
    }
  }
);

test(
  "clipboard rejection still launches the terminal and releases execution state",
  async () => {
    const harness = loadExecuteHandler(async () => {
      throw new Error("Clipboard permission denied");
    });

    await harness.execute("codegraph", "install-command");

    assert.deepEqual(harness.launches, ["codegraph"]);
    assert.equal(harness.executionStates[0], "codegraph");
    assert.equal(harness.executionStates.at(-1), null);
    assert.ok(
      harness.notices.some((notice) => /clipboard/i.test(notice)),
      "Clipboard failure must retain its user-visible notice"
    );
  }
);

test(
  "readiness terminal regression tests contain no explicit any casts",
  () => {
    const filePath = path.resolve(
      process.cwd(),
      "test/readiness-terminal-service.test.ts"
    );
    const source = readFileSync(filePath, "utf8");
    const ast = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const violations: number[] = [];

    function visit(node: ts.Node): void {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        node.type.kind === ts.SyntaxKind.AnyKeyword
      ) {
        const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        violations.push(location.line + 1);
      }
      ts.forEachChild(node, visit);
    }

    visit(ast);

    assert.deepEqual(
      violations,
      [],
      `Explicit any casts found at lines: ${violations.join(", ")}`
    );
  }
);
