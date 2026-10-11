import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isTranscriptBelongingToProject } from "../dist/src/main/services/TranscriptIngestionService.js";

test("null tool-call entries do not hide later structured ownership", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ownership-null-call-")
  );

  try {
    const projectRoot = path.join(directory, "project");
    await fs.mkdir(projectRoot);
    const transcriptPath = path.join(directory, "history.jsonl");

    await fs.writeFile(
      transcriptPath,
      JSON.stringify({
        tool_calls: [
          null,
          { args: null },
          { args: { Cwd: projectRoot } }
        ]
      }) + "\n",
      "utf8"
    );

    assert.equal(
      await isTranscriptBelongingToProject(transcriptPath, projectRoot),
      true
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("malformed records do not hide ownership in a later record", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ownership-malformed-record-")
  );

  try {
    const projectRoot = path.join(directory, "project");
    await fs.mkdir(projectRoot);
    const transcriptPath = path.join(directory, "history.jsonl");

    await fs.writeFile(
      transcriptPath,
      [
        "{invalid-json",
        "null",
        JSON.stringify({
          tool_calls: [{ args: { Cwd: projectRoot } }]
        })
      ].join("\n") + "\n",
      "utf8"
    );

    assert.equal(
      await isTranscriptBelongingToProject(transcriptPath, projectRoot),
      true
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
