import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function resolveGitHooksDir() {
  try {
    const raw = execSync("git rev-parse --git-path hooks", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    const trimmed = raw.trim();
    if (trimmed) {
      return path.resolve(trimmed);
    }
  } catch {
    // Fallback if git is unavailable in PATH
  }

  try {
    if (fs.existsSync(".git")) {
      const stat = fs.statSync(".git");
      if (stat.isDirectory()) {
        return path.resolve(".git", "hooks");
      }
      if (stat.isFile()) {
        const content = fs.readFileSync(".git", "utf-8");
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitDir = path.resolve(match[1].trim());
          const commondirFile = path.join(gitDir, "commondir");
          if (fs.existsSync(commondirFile)) {
            const commonDirRelative = fs.readFileSync(commondirFile, "utf-8").trim();
            const commonGitDir = path.resolve(gitDir, commonDirRelative);
            return path.join(commonGitDir, "hooks");
          }
          return path.join(gitDir, "hooks");
        }
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

const hooksDir = resolveGitHooksDir();
if (hooksDir) {
  const preCommitPath = path.join(hooksDir, "pre-commit");
  const content =
    "#!/usr/bin/env sh\n" +
    "# Git Pre-Commit Hook: Kin's Cockpit Autonomous Loop Gatekeeper\n" +
    'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"\n' +
    'node "$REPO_ROOT/scripts/hooks/pre-commit.mjs" "$@"\n';
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(preCommitPath, content, { mode: 0o755 });
    console.log("[HOOKS] Installed .git/hooks/pre-commit");
  } catch (err) {
    console.warn("[HOOKS] Warning: Could not write .git/hooks/pre-commit:", err.message);
  }
}
