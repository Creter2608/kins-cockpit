import fs from "node:fs";
import path from "node:path";

const hooksDir = path.resolve(".git", "hooks");
if (fs.existsSync(hooksDir)) {
  const preCommitPath = path.join(hooksDir, "pre-commit");
  const content = "#!/usr/bin/env sh\n# Git Pre-Commit Hook: Kin's Cockpit Autonomous Loop Gatekeeper\nnode scripts/hooks/pre-commit.mjs\n";
  try {
    fs.writeFileSync(preCommitPath, content, { mode: 0o755 });
    console.log("[HOOKS] Installed .git/hooks/pre-commit");
  } catch (err) {
    console.warn("[HOOKS] Warning: Could not write .git/hooks/pre-commit:", err.message);
  }
}
