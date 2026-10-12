# Kin's Multi-Agents UI 🤖⚡

[![Release: v3.0.0](https://img.shields.io/badge/Release-v3.0.0-emerald.svg)](package.json)
[![Tests: 597 passing](https://img.shields.io/badge/Tests-597%20passing-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-34-black.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-cyan.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38bdf8.svg)](https://tailwindcss.com/)
[![Docker Sandbox](https://img.shields.io/badge/Docker-Sandboxed-2496ed.svg)](https://www.docker.com/)

**Kin's Multi-Agents UI** (Kin's Cockpit) is a high-performance desktop mission-control cockpit engineered for autonomous AI pair programming across agentic CLI runtimes (Google Antigravity CLI, Claude Code, Cursor, Windsurf). It unifies interactive ConPTY terminal sessions, real-time telemetry HUD accounting, 10-phase autonomous loop orchestration, DeepSeek Harness bounded execution sandboxing, cryptographic pre-tool policy gates, and Docker container isolation into a single production workstation.

Repository: **[https://github.com/Creter2608/kins-cockpit](https://github.com/Creter2608/kins-cockpit)**

---

## 🚀 Welcome to v3.0.0 (First Official Production Release)

Version `3.0.0` represents the first official production release of Kin's Cockpit. This milestone transforms the experimental multi-agent harness into a hardened desktop application ready for daily engineering workflows:

1. **Autonomous Loop v3.0 Engine ([docs/LOOP.md](docs/LOOP.md))**:
   - Deterministic 10-phase lifecycle from project initialization through human release approval.
   - Dual-Oracle architecture: Stage 2 GPT Blueprint synthesis paired with Stage 4 GPT Adversarial Reality Auditing.
   - Fail-closed cryptographic handshakes (`blueprintApproval`, mutation session authority, and read-gate tracking).

2. **DeepSeek Harness Bounded Runtime**:
   - 3-tier execution confinement (`read-only`, `workspace-write`, `danger-full-access`) with recursive symlink escape defense.
   - Anti-loop execution guards (`REPEAT_TOOL_DETECTED` blocks >= 3 repetitive cycles) and bounded plan ceilings (max 16 steps).
   - Append-only session journaling (`SessionJournal.ts`) with crash-resilient uncommitted tail quarantine.
   - Programmatic Tool Calling (PTC) executor with independent 60-second non-cooperative tool timeouts.

3. **Zero-Pollution Everything Claude Code (ECC) Ecosystem Absorption**:
   - Read-only external capability catalog discovering agents and skills without cluttering client repositories.
   - 4-tier security quarantine defense: symlink escape traversal guards, 512 KiB size ceilings, zero-width space and bidirectional Unicode injection sanitization (`ECC-001`), and binary containment.
   - Dynamic token-budgeted skill context injection saving 35–50% context window tokens via markdown compaction and summary cards.

4. **Production Desktop Packaging & Readiness Diagnostics**:
   - High-DPI NSIS Windows installer and single-executable portable desktop editions.
   - Integrated System Readiness probe modal verifying Git, Node.js >= 22 LTS, Docker daemon, Antigravity CLI, and CodeGraph prerequisites.
   - Complete unpacked runtime layout ensuring pre-tool gatekeeper hooks execute seamlessly outside ASAR archives.

5. **Live Telemetry & Token Accounting HUD**:
   - Precise provider breakdown tracking GPT (in/out/cached with live hit %) and Gemini (with thinking/reasoning token accounting).
   - Fine-grained per-worktree and per-branch attribution ledger preventing duplicate billing.
   - Context optimization and deduplication analyzer flagging bloated prompt instructions.
   - Rolling provider capacity tracking rate limits, tokens remaining, and reset deadlines.

---

## ⚡ Canonical Autonomous Loop v3.0

The core loop enforces a strict, deterministic 10-phase state machine designed to prevent infinite loops, token drain, and unverified code commits:

```text
INITIALIZE ➔ SPEC_GATE ➔ ISOLATE (Git Worktree) ➔ DETECT_STACKS ➔ PLAN (Stage 2 GPT Architect) 
       ➔ EXECUTE (Layer 2 Gemini) ➔ VERIFY (Local CPU $0) ➔ REALITY_CHECK (Stage 4 GPT Adversary) 
       ➔ RELEASE_GATE (Human Sign-off) ➔ COMPLETE
```

### Phase Details

| Phase | Description | Gate / Invariant |
| :--- | :--- | :--- |
| **INITIALIZE** | Discovers workspace, parses configuration, and validates runtime prerequisites. | Fails closed if project root is invalid or inaccessible. |
| **SPEC_GATE** | Establishes requirements, boundaries, and acceptance criteria. | Requires user intent clarity before proceeding. |
| **ISOLATE** | Allocates an isolated Git worktree or workspace branch. | Protects the primary branch from unverified mutations. |
| **DETECT_STACKS** | Analyzes project build tools, package managers, and test runners. | Zero-token deterministic CPU probe. |
| **PLAN** | Stage 2 GPT Architect crafts technical specification and golden test assertions. | Emits compact assertions (~100 tokens); locks blueprint SHA-256. |
| **EXECUTE** | Layer 2 Gemini synthesizes production code adhering to Stage 2 blueprint. | PreToolUse gatekeeper validates HMAC signatures for every edit. |
| **VERIFY** | Executes local compilation, typechecking, and test suites on local CPU. | **$0 LLM token cost**; hard ceiling of 1 targeted fix retry. |
| **REALITY_CHECK** | Stage 4 GPT Adversary audits candidate diff (`git diff -U3`) against blueprint. | Defaults to "NEEDS WORK"; hunts regressions and broken contracts. |
| **RELEASE_GATE** | Submits verified test evidence and reality check verdict to operator. | **Human-in-the-Loop**: Interactive sign-off required before merge. |
| **COMPLETE** | Merges verified branch, logs session journal, and updates telemetry. | Clean working tree; zero leftover scratch files. |

---

## 🛡️ Security & PreToolUse Gatekeeper

Kin's Cockpit operates under a zero-trust model between autonomous agents and the host operating system:

1. **Protected Evaluation Zone (`.eval/`)**:
   - The `.eval/` test suite is strictly read-only. Any attempt to modify, relax, or delete golden assertions triggers an immediate `FAILED: SPECIFICATION_INTEGRITY` rejection.

2. **Cryptographic Mutation Authorization (`preToolUseHook.ts`)**:
   - File editing tools (`replace_file_content`, `write_to_file`) are intercepted by a native PreToolUse hook.
   - Mutations require an active HMAC-SHA256 session token (`MutationAuthorization`) binding `runId`, `canonicalWorkspacePath`, and `blueprintDigest`.
   - Edits outside the authorized `EXECUTE` phase or past lease expiry (`leaseExpiresAtMs`) are blocked automatically.

3. **Anti-Token-Drain Read Gate**:
   - Intercepts full-file read attempts on large source files (> 200 estimated tokens) in CodeGraph-enabled repositories.
   - Enforces symbol extraction via `codegraph_explore` before raw file reads are admitted, preventing accidental token blowups.

4. **Docker Container Sandbox (`kins_autonomous_sandbox`)**:
   - When active, dependency installations (`npm install`, `pip install`), builds, and test runs execute inside Docker.
   - Protects the host machine from untrusted scripts, supply-chain vulnerabilities, and accidental filesystem damage.

---

## 🧩 DeepSeek Harness Autonomous Runtime

Embedded in `src/main/harness/`, the DeepSeek Harness runtime enforces strict execution boundaries:

- **Sandbox Confinement (`SandboxPolicy.ts`)**:
  - `read-only`: Disallows all filesystem write operations.
  - `workspace-write`: Restricts mutations strictly to authorized repository paths.
  - `danger-full-access`: Full access mode with mandatory `.eval/` immutability preservation.
  - *Symlink Traversal Defense*: Resolves up to 16 hops of dangling symlinks to ensure target aliases cannot escape containment roots.

- **Loop Hygiene & Repetition Guards (`ExecutionGuard.ts`)**:
  - Fingerprints canonical JSON representations of tool calls.
  - Blocks the 3rd consecutive identical tool invocation (`REPEAT_TOOL_DETECTED`).
  - Enforces a hard ceiling of 16 steps per plan (`PLAN_STEP_LIMIT_EXCEEDED`).

- **Durable Append-Only Session Journal (`SessionJournal.ts`)**:
  - Monotonic sequence ordering (`sequence: 1, 2, ...`).
  - Mutex-serialized concurrent write protection.
  - Crash recovery with trailing corrupt line trimming and isolation.

- **Programmatic Tool Calling Executor (`ToolPlanExecutor.ts`)**:
  - Race-condition-free tool queuing.
  - Enforces 60-second timeouts even if child processes hang.

---

## 📦 Everything Claude Code (ECC) Ecosystem Absorption

Kin's Cockpit provides zero-pollution absorption of external agent and skill libraries:

- **Read-Only Capability Catalog (`EccCatalogService`)**:
  - Dynamically discovers external agents and skills from `~/.claude/` or custom folders without copying files or polluting repository roots.
  - Sidecar state and workspace configurations remain isolated in Electron `<userData>/`.

- **4-Tier Security Quarantine Sandbox**:
  - *Symlink Traversal Defense*: Resolves canonical paths via `fs.realpathSync`, blocking directory traversal escapes.
  - *Size Ceiling Enforcement*: Rejects assets exceeding 512 KiB to prevent memory exhaustion.
  - *Suspicious Unicode Quarantine (`SUSPICIOUS_UNICODE_REGEX`)*: Quarantines assets containing zero-width spaces (`\u200B\u200C\u200D\u2060\uFEFF`) or bidirectional markers (`\u200E\u200F\u202A-\u202E\u2066-\u2069`) to neutralize hidden prompt injection vectors (`ECC-001`).
  - *Payload Containment*: Isolates unverified binary and shell payloads.

- **Dynamic Skill Context Injector (`EccSkillContextInjector`)**:
  - Compacts markdown documents by stripping frontmatter, HTML comments, visual badges, and superfluous links.
  - Employs multi-byte safe UTF-8 slicing (`sliceUtf8Safe`) to prevent character corruption (`\uFFFD`).
  - Dual-budget packing (8 KiB per skill, 32 KiB aggregate limit) with intelligent fallback to structured summary cards, saving **35–50% context tokens**.

- **Interactive Dispatch UI (`EccCatalogView.tsx`, `SubagentSidebar.tsx`)**:
  - Dual-tab drawer (*Active Queue* vs *ECC Library*).
  - Search and filter across asset categories.
  - Interactive chip composer with live prompt previews and 1-click loop dispatching.

---

## 📊 Live Telemetry HUD & Token Accounting

Located in the persistent cockpit footer, the Telemetry HUD tracks real-time usage and financial spend:

- **Dual-Provider Breakdown**:
  - **Layer 1 GPT**: Tracks input, output, and cached tokens with live prompt cache hit rates ($2.00/1M uncached input, $0.10/1M cached input, $10.00/1M output).
  - **Layer 2 Gemini**: Tracks prompt and completion tokens, with completion tokens explicitly accounting for **Thinking / Reasoning tokens**.
- **Scope Toggle**: Switch instantly between active session metrics and cumulative all-time counters (`telemetry_alltime.json`).
- **Cost & Budget Circuit Breaker**: Configurable USD spend ceiling (`$0.50` default) alongside an autonomous token budget evaluating Layer 1 tokens against 50k (warning) and 60k (exceeded) limits.
- **Worktree Attribution Ledger**: Traces prompt and completion token consumption directly back to specific Git worktrees and branches with deterministic path hashing.
- **Context Optimization Analyzer**: Reports token overhead from duplicate instructions and unused registered MCP tools.
- **Provider Rolling Quota**: Monitors rate limits, remaining tokens/requests, and reset deadlines across configured providers.

---

## 🛠️ Tech Stack & Architecture

- **Desktop Runtime**: Electron 34 + Node.js 22 LTS
- **UI & Frontend**: React 19, TypeScript 5.7, Tailwind CSS 3.4, Lucide Icons
- **Terminal Core**: `@xterm/xterm`, `@xterm/addon-fit`, `node-pty` (ConPTY on Windows)
- **Build System**: Vite 6, esbuild (CommonJS preload bundling), TypeScript Compiler (`tsc`)
- **Packaging**: electron-builder 26 (NSIS installer & portable Windows builds)
- **Test Runner**: Node.js Native Test Runner (`node --test`), assert module (**597 deterministic tests passing 100%**)

### Repository Structure

```text
kins-multiagents-ui/
├── src/
│   ├── main/                  # Electron Main Process
│   │   ├── harness/           # DeepSeek Harness Runtime (SandboxPolicy, ExecutionGuard, SessionJournal, ToolPlanExecutor)
│   │   ├── services/          # Telemetry, WorktreeAttribution, ContextOptimization, ProviderCapacity,
│   │   │                      # EccCatalog, EccDispatcher, EccSkillContextInjector, SystemReadinessService,
│   │   │                      # preToolUseHookService, blueprintApprovalAuthenticator, PtyService
│   │   ├── ipc.ts             # Typed IPC event bridge (cockpitApi.*)
│   │   └── index.ts           # Window lifecycle & service bootstrapping
│   ├── preload/               # Secure context bridge (esbuild -> CommonJS)
│   ├── renderer/              # React 19 UI
│   │   ├── components/        # PhaseTracker, TelemetryHud, McpSidebar, RunActivityPanel, TerminalStage,
│   │   │                      # SystemReadinessModal, QualityGateDecisionModal, EccCatalogView, SubagentSidebar
│   │   ├── App.tsx            # Cockpit mission-control layout & event wiring
│   │   └── main.tsx           # UI entrypoint
│   ├── shared/                # Shared contracts, phases, usage, contracts, eccContracts, systemReadiness
│   ├── cli/                   # PreToolUse CLI gatekeeper hook (preToolUseHook.ts, preToolUseHookReadGate.ts)
│   └── engine.ts              # Canonical LoopEngine state machine
├── docs/
│   └── LOOP.md                # Normative Autonomous Loop v3.0 specification
├── wiki/                      # Karpathy LLM-Wiki Knowledge Base
│   ├── decisions/             # Architecture Decision Records (ADR-001, ADR-002, ADR-003)
│   ├── pitfalls.md            # Living pitfalls and cognitive traps registry
│   └── log.md                 # Autonomous execution log
├── test/                      # 597 automated unit, integration, and adversarial tests
├── scripts/                   # harness (aqi/, pricing/, schemas/), ai-loop.mjs, ai-exec.mjs, bundle-all.mjs
├── start-cockpit.bat          # 1-click Windows desktop batch launcher
└── .eval/                     # Read-only golden assertions locked by SHA-256
```

---

## 🚀 Quickstart & Installation

### Prerequisites

1. **Node.js**: `>= 22.0.0` LTS
2. **Git**: `>= 2.40.0`
3. **Docker Desktop** (Optional, recommended for sandboxed execution)
4. **CodeGraph CLI** (Optional, recommended for symbol extraction)

### Installation

For host-level development and desktop launcher execution:
```bash
git clone https://github.com/Creter2608/kins-cockpit.git
cd kins-multiagents-ui
npm install
```

> [!IMPORTANT]
> **Autonomous Agent Sandbox Requirement**: When executing autonomous engineering workflows, untrusted dependency installations and compilation tasks must run strictly inside the isolated Docker container `kins_autonomous_sandbox`:
> ```bash
> docker exec kins_autonomous_sandbox npm install
> ```

### Running Kin's Cockpit

1. **Quick Desktop Launcher (Windows)**:
   ```cmd
   start-cockpit.bat
   ```
   *Automatically checks build artifacts, compiles missing assets, and launches the Electron desktop app.*

2. **Generate Windows Desktop Shortcut**:
   ```bash
   npm run shortcut
   ```
   *Creates a `Kin's Cockpit.lnk` shortcut on your Desktop via PowerShell.*

3. **Development Mode (Vite Hot-Reload)**:
   ```bash
   npm run app:dev
   ```

4. **Production Desktop Build & Launch**:
   ```bash
   npm run build
   npm run app:start
   ```

5. **Package Windows Installers**:
   ```bash
   npm run pack:prepare
   npm run package        # Generates unpacked desktop binaries in release/
   npm run dist           # Generates NSIS installer (.exe)
   npm run dist:portable  # Generates standalone portable executable
   ```

---

## 🧪 Verification & Testing Commands

All verification commands execute locally on CPU at **$0 LLM token spend**. For autonomous agent workflows and container containment, verification suites must run strictly inside the isolated Docker sandbox `kins_autonomous_sandbox`:

- **Run Full Deterministic Test Suite (597 tests passing 100%)**:
  ```bash
  # Inside container sandbox (required for autonomous loop agents):
  docker exec kins_autonomous_sandbox npm test
  # Host shell alternative:
  npm test
  ```
- **Strict TypeScript Typecheck**:
  ```bash
  docker exec kins_autonomous_sandbox npm run typecheck
  ```
- **Architectural Quality Index (AQI v2.0) Audit**:
  ```bash
  docker exec kins_autonomous_sandbox node scripts/harness/aqi.mjs
  docker exec kins_autonomous_sandbox node scripts/harness/aqi.test.mjs
  ```
- **Byte-Capped Test Runner (32 KiB terminal safety ceiling)**:
  ```bash
  docker exec kins_autonomous_sandbox npm run test:ai
  ```
- **Verify Golden Assertions against SHA-256**:
  ```bash
  docker exec kins_autonomous_sandbox node scripts/ai-loop.mjs verify
  ```

---

## 🔧 Troubleshooting

| Symptom | Root Cause | Solution |
| :--- | :--- | :--- |
| **System Readiness: CodeGraph Missing** | `codegraph` executable not found in system PATH. | Install CodeGraph or ensure it is accessible in system PATH. |
| **PreToolUse Hook: `Cannot find module`** | Unpacked hook missing service dependencies. | Resolved in v3.0.0 via expanded `asarUnpack` configuration covering `dist/src/main/services/**/*` and `dist/src/shared/**/*`. |
| **PreToolUse Hook: `Mutation authorization denied (EXPIRED)`** | Mutation session lease expired (fail-closed security invariant). | Renew mutation lease via authorized harness handshake; one-shot planning oracle is strictly invoked only once per task and cannot be looped. |
| **PreToolUse Hook: `Anti-Token-Drain Protocol: view_file denied`** | Full file read requested for large source file in CodeGraph repo. | Run `codegraph_explore` first to inspect specific symbols rather than dumping whole files. |
| **Docker Status: Daemon Offline** | Docker Desktop is not running or socket is unavailable. | Start Docker Desktop, or continue using native host execution if acceptable. |

---

## 📄 License

MIT © [Kin / Creter2608](https://github.com/Creter2608)
