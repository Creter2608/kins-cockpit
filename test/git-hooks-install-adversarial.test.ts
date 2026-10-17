import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const installerPath = path.resolve(
  process.cwd(),
  "scripts/install-git-hooks.mjs"
);

test("installer creates a missing hooks directory in a valid Git repository", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "kins-hooks-missing-")
  );

  try {
    const repository = path.join(temporaryRoot, "repository");

    execFileSync("git", ["init", "--template=", repository], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    const hooksDirectory = path.join(repository, ".git", "hooks");
    await fs.rm(hooksDirectory, { recursive: true, force: true });

    const result = spawnSync(process.execPath, [installerPath], {
      cwd: repository,
      encoding: "utf8"
    });

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `Installer failed:\n${result.stdout}\n${result.stderr}`
    );

    const hookPath = path.join(hooksDirectory, "pre-commit");
    const content = await fs.readFile(hookPath, "utf8");

    assert.ok(
      content.includes('node "$REPO_ROOT/scripts/hooks/pre-commit.mjs" "$@"'),
      "Installed hook must invoke the script through the runtime repository root"
    );

    if (process.platform !== "win32") {
      const metadata = await fs.stat(hookPath);
      assert.notEqual(
        metadata.mode & 0o111,
        0,
        "Installed hook must be executable"
      );
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("installer fallback follows a linked worktree's commondir", async () => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "kins-hooks-worktree-")
  );

  try {
    const worktree = path.join(temporaryRoot, "linked");
    const commonGitDirectory = path.join(temporaryRoot, "common.git");
    const privateGitDirectory = path.join(
      commonGitDirectory,
      "worktrees",
      "linked"
    );
    const commonHooksDirectory = path.join(commonGitDirectory, "hooks");
    const emptyPathDirectory = path.join(temporaryRoot, "empty-path");

    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(privateGitDirectory, { recursive: true });
    await fs.mkdir(commonHooksDirectory, { recursive: true });
    await fs.mkdir(emptyPathDirectory, { recursive: true });

    await fs.writeFile(
      path.join(worktree, ".git"),
      "gitdir: ../common.git/worktrees/linked\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(privateGitDirectory, "commondir"),
      "../..\n",
      "utf8"
    );

    // Preserve platform-required environment variables, while ensuring that
    // the installer's Git subprocess cannot be found through PATH.
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === "PATH") {
        delete environment[key];
      }
    }
    environment.PATH = emptyPathDirectory;

    const result = spawnSync(process.execPath, [installerPath], {
      cwd: worktree,
      env: environment,
      encoding: "utf8"
    });

    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `Installer failed:\n${result.stdout}\n${result.stderr}`
    );

    const content = await fs.readFile(
      path.join(commonHooksDirectory, "pre-commit"),
      "utf8"
    );
    assert.ok(
      content.includes('node "$REPO_ROOT/scripts/hooks/pre-commit.mjs" "$@"'),
      "Fallback must install into the shared hooks directory"
    );

    await assert.rejects(
      fs.access(path.join(privateGitDirectory, "hooks", "pre-commit")),
      { code: "ENOENT" }
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
