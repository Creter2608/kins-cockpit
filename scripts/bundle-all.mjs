import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const projectRoot = process.cwd();
const bundledDir = path.resolve(projectRoot, "resources", "bundled");

const SENSITIVE_NAMES = new Set([
  ".git", "node_modules", ".cache", ".env", ".npmrc", ".pypirc",
  "Thumbs.db", ".DS_Store"
]);
const SENSITIVE_EXTS = new Set([".key", ".pem", ".pfx", ".p12", ".crt", ".log"]);

function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // Prevent symlink escapes (CWE-59)
    if (SENSITIVE_NAMES.has(entry.name) || entry.name.startsWith(".env")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SENSITIVE_EXTS.has(ext)) continue;

    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
      count++;
    }
  }
  return count;
}

fs.mkdirSync(bundledDir, { recursive: true });

// 1. Superpowers
const spSrc = path.join(os.homedir(), ".gemini", "config", "plugins", "superpowers", "skills");
if (!fs.existsSync(spSrc)) {
  console.error(`[ERROR] Missing required Superpowers skills directory: ${spSrc}`);
  process.exit(1);
}
const spDst = path.join(bundledDir, "superpowers");
const spCount = copyDirRecursive(spSrc, spDst);
if (spCount < 10) {
  console.error(`[ERROR] Incomplete Superpowers skills bundle: expected >= 10, got ${spCount}`);
  process.exit(1);
}
console.log("[BUNDLE] Superpowers:", spCount, "files");

// 2. Agency Core
const acSrc = path.join(os.homedir(), ".gemini", "config", "plugins", "agency-core", "skills");
if (!fs.existsSync(acSrc)) {
  console.error(`[ERROR] Missing required Agency Core skills directory: ${acSrc}`);
  process.exit(1);
}
const acDst = path.join(bundledDir, "agency-core");
const acCount = copyDirRecursive(acSrc, acDst);
if (acCount < 5) {
  console.error(`[ERROR] Incomplete Agency Core bundle: expected >= 5 files, got ${acCount}`);
  process.exit(1);
}
console.log("[BUNDLE] Agency-Core:", acCount, "files");

// 3. MCP Schemas
const mcpSrc = path.join(os.homedir(), ".gemini", "antigravity-cli", "mcp");
if (!fs.existsSync(mcpSrc)) {
  console.error(`[ERROR] Missing required MCP schemas directory: ${mcpSrc}`);
  process.exit(1);
}
const mcpDst = path.join(bundledDir, "mcp-schemas");
const mcpCount = copyDirRecursive(mcpSrc, mcpDst);
if (mcpCount < 2) {
  console.error(`[ERROR] Incomplete MCP schemas bundle: expected >= 2, got ${mcpCount}`);
  process.exit(1);
}
console.log("[BUNDLE] MCP Schemas:", mcpCount, "files");

// 4. ECC
const eccRoot = path.resolve(projectRoot, "../ECC");
if (!fs.existsSync(eccRoot)) {
  console.error(`[ERROR] Missing required ECC repository root: ${eccRoot}`);
  process.exit(1);
}
const eccDst = path.join(bundledDir, "ecc");
fs.mkdirSync(eccDst, { recursive: true });
const eccSubdirs = ["agents", "skills", "rules", "hooks", "mcp-configs", "manifests", "contexts"];
let eccTotalCount = 0;
for (const sub of eccSubdirs) {
  const sPath = path.join(eccRoot, sub);
  const dPath = path.join(eccDst, sub);
  if (fs.existsSync(sPath)) {
    eccTotalCount += copyDirRecursive(sPath, dPath);
  }
}
if (eccTotalCount < 794) {
  console.error(`[ERROR] Incomplete ECC inventory: expected >= 794 files, got ${eccTotalCount}`);
  process.exit(1);
}
console.log("[BUNDLE] ECC:", eccTotalCount, "files");

// 5. Dockerfile
const dockerDst = path.join(bundledDir, "docker");
fs.mkdirSync(dockerDst, { recursive: true });
const dockerContent = "FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*\nRUN git config --global --add safe.directory '*'\nWORKDIR /workspace\nCMD [\"tail\", \"-f\", \"/dev/null\"]\n";
fs.writeFileSync(path.join(dockerDst, "Dockerfile"), dockerContent, "utf-8");
console.log("[BUNDLE] Dockerfile created");
console.log("[BUNDLE] Done!");
