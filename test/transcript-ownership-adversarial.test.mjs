import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";

const serviceUrl = new URL(
  "../src/main/services/TranscriptIngestionService.ts",
  import.meta.url
);

const source = await fs.readFile(serviceUrl, "utf8");
const start = source.indexOf("export function isPathInsideOrEqual(");
const end = source.indexOf(
  "export class TranscriptIngestionService",
  start
);

assert.ok(start >= 0, "Ownership path helper must exist");
assert.ok(end > start, "Ownership helper extraction boundary must exist");

const helperSource = `
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
${source.slice(start, end)}
`;

const compiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext
  }
}).outputText;

const {
  isPathInsideOrEqual,
  isTranscriptBelongingToProject
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("ownership recognizes a complete EOF record without a newline", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "transcript-eof-")
  );

  try {
    const projectRoot = path.join(directory, "project");
    await fs.mkdir(projectRoot);

    const transcriptPath = path.join(directory, "history.jsonl");
    const ownershipRecord = JSON.stringify({
      tool_calls: [{ args: { Cwd: projectRoot } }]
    });

    // Evidence occurs after 16 KiB but well inside the search ceiling.
    const prefix = `${JSON.stringify({
      content: "x".repeat(20 * 1024)
    })}\n`;

    await fs.writeFile(
      transcriptPath,
      prefix + ownershipRecord,
      "utf8"
    );

    assert.equal(
      await isTranscriptBelongingToProject(
        transcriptPath,
        projectRoot
      ),
      true,
      "A complete ownership record at EOF must not require a newline"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("path containment accepts dot-prefixed descendants but rejects escape", () => {
  const projectRoot = path.resolve(
    os.tmpdir(),
    "transcript-path-project"
  );

  assert.equal(
    isPathInsideOrEqual(
      path.join(projectRoot, "..cache", "transcript.json"),
      projectRoot
    ),
    true,
    "A directory named '..cache' is a descendant, not parent traversal"
  );

  assert.equal(
    isPathInsideOrEqual(projectRoot, projectRoot),
    true
  );

  assert.equal(
    isPathInsideOrEqual(
      path.resolve(projectRoot, "..", "outside"),
      projectRoot
    ),
    false,
    "Actual parent traversal must remain rejected"
  );
});

test("ownership beyond the 256 KiB ceiling is not accepted", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "transcript-ceiling-")
  );

  try {
    const projectRoot = path.join(directory, "project");
    await fs.mkdir(projectRoot);

    const transcriptPath = path.join(directory, "history.jsonl");
    const prefix = `${JSON.stringify({
      content: "x".repeat(256 * 1024)
    })}\n`;

    assert.ok(Buffer.byteLength(prefix, "utf8") > 256 * 1024);

    await fs.writeFile(
      transcriptPath,
      prefix +
        JSON.stringify({
          tool_calls: [{ args: { Cwd: projectRoot } }]
        }) +
        "\n",
      "utf8"
    );

    assert.equal(
      await isTranscriptBelongingToProject(
        transcriptPath,
        projectRoot
      ),
      false,
      "EOF handling must not expand the ownership-search ceiling"
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
