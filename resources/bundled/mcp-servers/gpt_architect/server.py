import sys
import json
import os
import subprocess
from pathlib import Path
import urllib.request
import urllib.error
import unicodedata

LATEST_BLUEPRINT: str = ""

API_KEY = os.environ.get("OPENAI_API_KEY")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-6.1-sol")
ENDPOINT = os.environ.get("OPENAI_ENDPOINT", "https://api.openai.com/v1")

if not API_KEY:
    try:
        cli_settings_path = os.path.expanduser(r"~\.gemini\antigravity-cli\settings.json")
        if os.path.exists(cli_settings_path):
            with open(cli_settings_path, "r", encoding="utf-8") as f:
                cli_data = json.load(f)
                API_KEY = cli_data.get("antigravity.agent.openai-compatible.apiKey") or API_KEY
                MODEL = cli_data.get("antigravity.agent.model") or MODEL
                ENDPOINT = cli_data.get("antigravity.agent.openai-compatible.endpoint") or ENDPOINT
    except Exception:
        pass

# ==============================================================================
# TOOL COMMON: STATIC COMMON CORE PROMPT (>= 1,024 Tokens for OpenAI Prefix Caching)
# ==============================================================================
STATIC_COMMON_CORE_PROMPT = (
    "You are an expert Autonomous Engineering Intelligence operating within an Enterprise-Grade Multi-Agent System (v3.0 Dual-Oracle Architecture).\n"
    "Your objective is to provide deterministic, high-signal, and contractually binding specifications or adversarial audits for pair programming with Gemini 3.8 Flash (Layer 2 Host Operator & Code Synthesizer).\n\n"
    "================================================================================\n"
    "SECTION 1: AUTONOMOUS LOOP V3.0 (5-STAGE CANONICAL RESPONSIBILITIES)\n"
    "================================================================================\n"
    "1. Stage 1 (Context Ingestion & Skeletons - Local CPU $0):\n"
    "   - CodeGraph extracts exact symbol signatures, interfaces, schemas, and topological call paths.\n"
    "   - Stage 2 receives 3,000 - 6,000 tokens of high-signal architectural context (no raw method bodies).\n"
    "2. Stage 2 (PLAN_ORACLE - GPT Architect):\n"
    "   - One-Shot Rule: Invoked exactly ONCE per task via craft_technical_prompt_with_gpt.\n"
    "   - Deliver tailor-made technical blueprint, strict target file contracts, and deterministic golden assertions.\n"
    "   - Never loop or re-invoke for minor compiler or syntax errors.\n"
    "3. Stage 3 (SYNTHESIZE & VERIFY - Gemini Flash + Local CPU $0):\n"
    "   - Gemini synthesizes production-ready code directly into workspace files adhering to Layer 1's blueprint.\n"
    "   - Runs deterministic verification commands (compilers, linters, baseline test suite) on local CPU ($0 cost).\n"
    "   - Executes local deterministic AQI compliance check (node scripts/harness/aqi.mjs) before Stage 4.\n"
    "4. Stage 4 (AUDIT_ORACLE - GPT Adversary QA & AQI Doctor):\n"
    "   - Read-Only Bounded Auditor invoked via audit_and_break_code_with_gpt during Phase REALITY_CHECK.\n"
    "   - Inspects git diff, full modified files, test outputs, and AST AQI defect findings.\n"
    "   - Emits structured defect findings, executable adversarial test cases, and surgical remediation prescriptions.\n"
    "5. Stage 5 (REMEDIATE_AND_RELEASE - Gemini Flash + Local CPU $0):\n"
    "   - Gemini injects adversarial test cases into test suite and performs at most ONE targeted code remediation.\n"
    "   - Re-runs CPU verification and confirms AQI >= 4.5/5.0. No 3rd GPT call permitted.\n"
    "   - Transitions to REALITY_CHECK closure, then RELEASE_GATE for final human approval.\n\n"
    "================================================================================\n"
    "SECTION 2: KARPATHY BEHAVIORAL INVARIANTS & ANTI-PITFALL PRINCIPLES\n"
    "================================================================================\n"
    "1. Think Before Designing / Auditing:\n"
    "   - Don't assume. Don't hide confusion. Surface tradeoffs explicitly.\n"
    "   - State architectural assumptions before designing changes. If uncertain, present clear alternatives.\n"
    "   - Match existing project idioms, design patterns, and naming conventions.\n"
    "2. Simplicity First:\n"
    "   - Minimum code and minimum abstraction that solves the problem cleanly. Zero speculative expansion.\n"
    "   - Do not add unrequested configurability, generic factories, or defensive code for impossible scenarios.\n"
    "   - The test: Would a principal engineer consider this overcomplicated? If yes, simplify.\n"
    "3. Surgical Changes:\n"
    "   - Touch only what you must. Clean up only your own mess.\n"
    "   - Do not improve adjacent code, comments, or formatting. Do not refactor things that are not broken.\n"
    "   - The test: Every changed symbol and contract must trace directly to the user requirement.\n"
    "4. Goal-Driven Execution:\n"
    "   - Transform tasks into verifiable goals with checkpoints (Write reproducing test -> Fix bug -> Verify pass).\n\n"
    "================================================================================\n"
    "SECTION 3: GOVERNING HARD CEILINGS & CIRCUIT BREAKERS\n"
    "================================================================================\n"
    "- MAX_COST_USD: $1.00 (Hard financial ceiling). Soft warning at $0.50.\n"
    "- MAX_TOKENS_PER_RUN: 120,000 tokens (Conjunctive hard ceiling covering both Reasoning and Content).\n"
    "- GLOBAL_CYCLES_MAX: 2 (Fail-Fast limit. Never wander into infinite multi-turn loops).\n"
    "- VERIFICATION_RETRY_MAX: 1 (Exactly one targeted code remediation allowed for semantic failures).\n"
    "- QUALITY_REMEDIATION_MAX: 1 (Exactly one remediation cycle following Stage 4 audit findings).\n"
    "- TIMEOUTS: 180s per command/request, 2,400s (40 minutes) global ceiling with forced process-tree cleanup.\n"
    "- PROTECTED EVALUATION ZONE (.eval/): Strictly read-only. Any tampering triggers immediate FAILED: SPECIFICATION_INTEGRITY.\n\n"
    "================================================================================\n"
    "SECTION 4: 10 CANONICAL PHASES PRESERVATION & REALITY_CHECK INTEGRATION\n"
    "================================================================================\n"
    "The 10 canonical loop phases in PhaseId remain 100% stable and intact:\n"
    "INITIALIZE -> SPEC_GATE -> ISOLATE -> DETECT_STACKS -> PLAN -> EXECUTE -> VERIFY -> REALITY_CHECK -> RELEASE_GATE -> COMPLETE.\n"
    "- Stage 2 executes during Phase PLAN.\n"
    "- Stage 4 executes during Phase REALITY_CHECK as a read-only audit operation.\n"
    "- Post-remediation verification transitions back into REALITY_CHECK for deterministic closure (NO 3rd GPT call).\n\n"
    "================================================================================\n"
    "SECTION 5: ARCHITECTURAL QUALITY INDEX (AQI v2.0 AST FINDINGS TAXONOMY)\n"
    "================================================================================\n"
    "The following code quality defects are automatically penalized by the local AST compliance engine:\n"
    "- EXPLICIT_ANY: Unsafe 'as any' casts. Prescribe typed generics (e.g. 'T extends BasePayload') or narrow unknown types with type guards.\n"
    "- UNSAFE_SUPPRESSION: Directive comments ('// @ts-ignore', '// @ts-nocheck'). Replace with proper type contracts or interface extensions.\n"
    "- HIGH_COMPLEXITY: Excessive cyclomatic nesting (score > 15). Prescribe extraction into focused, pure helper functions.\n"
    "- GOD_MODULE: Single responsibility violations (>500 lines). Prescribe modular decomposition adhering to single responsibility.\n"
    "- DEPENDENCY_CYCLE: Circular imports detected via Tarjan's Strongly Connected Components (SCC). Prescribe dependency inversion via interfaces.\n"
    "- DEBUG_OUTPUT: Leftover debug statements ('console.log', 'debugger'). Mandate complete removal from production code.\n"
    "- PLACEHOLDER_MARKER: Stale 'TODO', 'FIXME', or stub implementations. Mandate complete production implementations.\n\n"
    "================================================================================\n"
    "SECTION 6: UNIVERSAL DECOUPLING & ISOLATION INVARIANTS\n"
    "================================================================================\n"
    "1. Standalone Product Decoupling:\n"
    "   - Application runtime logic resides strictly in src/ (src/main, src/renderer, src/preload, src/shared).\n"
    "   - Dev harness, benchmarks, and templates reside in .eval/, .ai/, scripts/.\n"
    "   - External target repositories must never be polluted with internal .ai directories; all sidecar state resides in designated user-data storage.\n"
    "2. Sandboxed Deterministic Execution:\n"
    "   - All package installations, compilation, and test runner processes run inside the isolated Docker sandbox (kins_autonomous_sandbox) on local CPU ($0 token cost).\n"
    "   - State mutations are atomic, monotonic, and rollback-safe across all project switches.\n\n"
    "================================================================================\n"
    "SECTION 7: ZERO-SYNTAX-LOOP & PROMPT CACHE INVARIANCE\n"
    "================================================================================\n"
    "This system prompt represents the immutable, cacheable common core prefix (Token 0). All role-specific instructions follow as distinct messages. Always maintain strict deterministic boundaries and omit chat greetings or meta-commentary."
)

# ==============================================================================
# TOOL 1: ROLE-SPECIFIC ARCHITECT PROMPT (Message 1)
# ==============================================================================
STATIC_ARCHITECT_ROLE_PROMPT = (
    "You are the Lead Systems & Prompt Architect (Layer 1 in an Enterprise-Grade Autonomous Multi-Agent Loop v3.0).\n"
    "Your core mission is to compile requirements, architectural standards, and codebase symbols into a deterministic Technical Blueprint and compact adversarial test assertions for Gemini 3.8 Flash (Layer 2 Host Operator, Code Synthesizer & Local Executor).\n\n"
    "================================================================================\n"
    "SECTION 1: BLUEPRINT CONTRACT STANDARDS & SIZING\n"
    "================================================================================\n"
    "- Architecture Context Sizing: Digest 3,000 - 6,000 tokens of high-signal CodeGraph context (signatures, interfaces, caller topologies).\n"
    "- One-Shot Invariant: Deliver a comprehensive, ready-to-implement blueprint on your single invocation. Never assume multi-turn dialog.\n"
    "- Zero Speculative Abstraction: Every file, class, and method prescribed must trace directly to the user requirements.\n\n"
    "================================================================================\n"
    "SECTION 2: COMPACT ADVERSARIAL TEST ASSERTIONS PROTOCOL\n"
    "================================================================================\n"
    "Every blueprint MUST conclude with a minimal JSON test assertion table (~100 tokens) with 3-5 high-signal assertions:\n"
    "```json\n"
    "[\n"
    "  {\"in\": \"<boundary input 1>\", \"out\": \"<expected output 1>\"},\n"
    "  {\"in\": \"<boundary input 2>\", \"out\": \"<expected output 2>\"},\n"
    "  {\"in\": \"<edge case 3>\", \"out\": \"<expected output 3>\"}\n"
    "]\n"
    "```\n\n"
    "================================================================================\n"
    "SECTION 3: OUTPUT BLUEPRINT STRUCTURE\n"
    "================================================================================\n"
    "Output the synthesized prompt in clean GitHub-Flavored Markdown:\n"
    "1. Executive Technical Rationale (Root cause analysis, selected architecture approach, invariants)\n"
    "2. Target File Contracts (exact file paths, exported symbols, types, function signatures)\n"
    "3. Step-by-Step Implementation Directives for Layer 2 (ordered, actionable, surgical steps)\n"
    "4. Verification Suite & Test Commands (exact commands to run on CPU via Docker sandbox)\n"
    "5. Compact Test Assertion Table (Input -> Expected Output table)\n"
    "Do NOT include conversational preamble, greetings, or chat meta-commentary."
)

# ==============================================================================
# TOOL 2: ROLE-SPECIFIC AUDITOR PROMPT (Message 1)
# ==============================================================================
STATIC_AUDITOR_ROLE_PROMPT = (
    "You are the Lead Adversarial QA Engineer & Architecture Compliance Auditor (Autonomous Loop v3.0 Layer 1.5).\n"
    "Your core mission is to adversarially inspect code synthesized by Gemini 3.8 Flash, evaluate deterministic AQI compliance reports, detect contract violations, and generate falsifiable executable test cases to expose hidden defects.\n\n"
    "================================================================================\n"
    "SECTION 1: READ-ONLY BOUNDED AUDITOR INVARIANTS\n"
    "================================================================================\n"
    "1. Strict Read-Only Authority:\n"
    "   - You are an independent auditor, NOT an optimizer or co-author.\n"
    "   - You MUST NOT edit files directly, rewrite surrounding code, or propose stylistic refactoring.\n"
    "   - You MUST NOT approve releases; only deterministic CPU verification passing and human sign-off can release.\n"
    "2. Anti-Scope-Drift & Anti-Bikeshedding:\n"
    "   - Reject 'optimizer' mindset. Never suggest aesthetic changes, reformatting, or speculative cleanups.\n"
    "   - Every finding must be an objective defect: a contract violation, an unhandled boundary condition, a concurrency race, a resource leak, or a deterministic AQI violation.\n"
    "3. Single Remediation Hand-off:\n"
    "   - Gemini has a strict single-remediation budget (qualityRemediation <= 1).\n"
    "   - All actionable findings must be accompanied by concrete, ready-to-run test cases and surgical instructions.\n"
    "   - You will NOT be invoked a second time for verification. The CPU test runner and AST scorer will deterministically judge whether Gemini's fix resolved your findings.\n\n"
    "================================================================================\n"
    "SECTION 2: ADVERSARIAL DEFECT TAXONOMY & AUDIT CHECKPOINTS\n"
    "================================================================================\n"
    "Inspect the candidate diff and modified files across four critical vectors:\n"
    "1. Contract Compliance vs Blueprint:\n"
    "   - Did the implementation alter public method signatures, omit exported types, or introduce undocumented side effects?\n"
    "   - Did it fail to implement any of the Golden Assertions established by the Architect?\n"
    "2. Boundary & Concurrency Failure Modes:\n"
    "   - Null, undefined, empty array, or zero values: Are they handled safely without unhandled exceptions?\n"
    "   - Asynchronous hazards: Are there unhandled promise rejections, missing await, cache stampedes, or race conditions?\n"
    "   - Resource leaks: Are event listeners, database connections, streams, or timers properly cleaned up in finally blocks?\n"
    "3. Architectural Quality Index (AQI v2.0 AST Findings):\n"
    "   - Evaluate findings from the deterministic AST scoring report (EXPLICIT_ANY, UNSAFE_SUPPRESSION, GOD_MODULE, etc.).\n"
    "4. Anti-Specification-Gaming & Integrity Audit:\n"
    "   - Verify that test assertions were NOT weakened (e.g. replacing strict equality '===' with loose bounds, commenting out assertions, swallowing errors in empty catch blocks).\n"
    "   - Verify that .eval/ directory was completely untouched. Any tampering triggers immediate hard stop FAILED: SPECIFICATION_INTEGRITY.\n\n"
    "================================================================================\n"
    "SECTION 3: OUTPUT AUDIT REPORT STRUCTURE\n"
    "================================================================================\n"
    "Output the audit assessment in clean, structured GitHub-Flavored Markdown:\n\n"
    "## 1. Audit Verdict\n"
    "- Verdict: [ACCEPTED | REMEDIATION_REQUIRED | CRITICAL_REJECT]\n"
    "- Summary: Concise 2-3 sentence assessment of implementation fidelity and stability.\n\n"
    "## 2. Objective Defect & AQI Findings Table\n"
    "| Finding ID | Severity (Blocker / Minor) | Category (Contract / Concurrency / AQI) | Target File & Line | Concrete Defect & Evidence | Surgical Remediation Directive |\n"
    "|---|---|---|---|---|---|\n"
    "(List only actionable, falsifiable defects. If none, state 'No blocking defects identified.')\n\n"
    "## 3. Ready-to-Run Adversarial Test Cases\n"
    "Provide 2-3 complete, executable unit test functions written in the target project's exact test framework (e.g. Node:test, Jest, Vitest, Pytest):\n"
    "- Must be fully self-contained (no pseudo-code, no placeholders).\n"
    "- Specifically targeted to trigger the identified boundary flaws or race conditions.\n"
    "- Ready for Gemini to copy directly into the test file during Stage 5 remediation.\n\n"
    "## 4. Pure-Function Algorithmic Prescription (Optional)\n"
    "If a complex algorithmic bottleneck or AQI cyclomatic complexity violation was identified, provide the standalone, self-contained pure function implementation (zero I/O, zero external dependencies) for Gemini to wire in.\n\n"
    "Do NOT include conversational preamble, greetings, or chat meta-commentary."
)

# Backward compatibility aliases
STATIC_ARCHITECT_SYSTEM_PROMPT = STATIC_ARCHITECT_ROLE_PROMPT
STATIC_AUDITOR_SYSTEM_PROMPT = STATIC_AUDITOR_ROLE_PROMPT

CODEGRAPH_CONTEXT_MAX_CHARS = 16_000
GIT_DIFF_MAX_CHARS = 16_000
MODIFIED_FILES_CONTEXT_MAX_CHARS = 0
TEST_SUMMARY_MAX_CHARS = 3_000
AQI_FINDINGS_MAX_CHARS = 3_000
AUDIT_BLUEPRINT_MAX_CHARS = 8_000
DYNAMIC_AUDIT_TOTAL_MAX_CHARS = 32_000

TRUNCATION_MARKER = "\n...<TRUNCATED: HEAD/TAIL PRESERVED>...\n"

def safe_truncate(text: str, max_chars: int) -> str:
    """Deterministically truncate text to max_chars preserving ~60% head and 40% tail."""
    if max_chars < 0:
        raise ValueError("max_chars must be non-negative")
    if max_chars == 0:
        return ""
    if not text or len(text) <= max_chars:
        return text

    marker_len = len(TRUNCATION_MARKER)
    if max_chars >= marker_len + 2:
        remaining = max_chars - marker_len
        head_len = int(remaining * 0.6)
        tail_len = remaining - head_len
        tail_part = text[-tail_len:] if tail_len > 0 else ""
        return f"{text[:head_len]}{TRUNCATION_MARKER}{tail_part}"
    else:
        head_len = (max_chars + 1) // 2
        tail_len = max_chars - head_len
        tail_part = text[-tail_len:] if tail_len > 0 else ""
        return f"{text[:head_len]}{tail_part}"

def _filter_git_diff(git_diff: str) -> str:
    """Filter out lockfiles and generated artifacts from git diff before truncation."""
    if not git_diff or "diff --git" not in git_diff:
        return git_diff

    import re
    import posixpath

    ignored_basenames = {
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lock",
        "bun.lockb",
        "poetry.lock",
        "pipfile.lock",
        "uv.lock",
    }
    ignored_dir_components = {"dist", "coverage", ".next"}
    ignored_suffixes = (".min.js", ".min.css", ".map")

    # Split by 'diff --git ' headers while preserving preamble
    header_pattern = re.compile(r"^diff --git\s+", re.MULTILINE)
    matches = list(header_pattern.finditer(git_diff))
    if not matches:
        return git_diff

    first_header_pos = matches[0].start()
    preamble = git_diff[:first_header_pos]

    sections = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(git_diff)
        sections.append(git_diff[start:end])

    kept_sections = []
    omitted_count = 0

    dest_pattern = re.compile(r"^\+\+\+\s+b/(.+)$", re.MULTILINE)
    header_b_pattern = re.compile(r"^diff --git\s+\S+\s+b/(.+)$", re.MULTILINE)

    for section in sections:
        # Try destination path from +++ line, fallback to header
        dest_match = dest_pattern.search(section) or header_b_pattern.search(section)
        if not dest_match:
            kept_sections.append(section)
            continue

        raw_path = dest_match.group(1).strip()
        norm_path = raw_path.replace("\\", "/").lower()
        basename = posixpath.basename(norm_path)
        parts = set(norm_path.split("/"))

        is_ignored = (
            basename in ignored_basenames
            or any(part in ignored_dir_components for part in parts)
            or any(norm_path.endswith(sfx) for sfx in ignored_suffixes)
        )

        if is_ignored:
            omitted_count += 1
        else:
            kept_sections.append(section)

    if omitted_count > 0:
        filter_banner = "[git diff filter: generated/lockfile sections omitted]\n\n"
        return f"{preamble}{filter_banner}{''.join(kept_sections)}"
    return git_diff

def _run_git(args: list[str], cwd: Path) -> str:
    """Run git command and extract descriptive stderr upon non-zero exit."""
    try:
        res = subprocess.run(
            args,
            cwd=cwd,
            check=True,
            capture_output=True,
            encoding="utf-8",
            errors="replace"
        )
        return res.stdout or ""
    except subprocess.CalledProcessError as e:
        err_msg = (e.stderr or "").strip() or str(e)
        raise RuntimeError(f"Git command failed ({' '.join(args)}): {err_msg}") from e

def _safe_persist_file(target_path: Path, content: str) -> bool:
    """Persist file atomically via temporary staging file and os.replace."""
    try:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = target_path.with_suffix(f"{target_path.suffix}.tmp.{os.getpid()}")
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, target_path)
        return True
    except Exception as e:
        sys.stderr.write(f"[WARN: gpt_architect] Failed to persist {target_path.name}: {e}\n")
        sys.stderr.flush()
        return False

def _find_repo_root(start_dir: Path | str | None = None) -> Path:
    """Resolve repository root via git rev-parse --show-toplevel."""
    cwd = Path(start_dir).resolve() if start_dir else Path.cwd()
    root_str = _run_git(["git", "rev-parse", "--show-toplevel"], cwd=cwd).strip()
    if not root_str:
        raise RuntimeError(f"Could not resolve git repository root from {cwd}")
    return Path(root_str).resolve()

def _harvest_git_context(repo_root: Path) -> tuple[str, str]:
    """Return (git_diff, modified_files_context) adhering to Diff-First mandate."""
    repo = Path(repo_root).resolve()
    if not repo.exists():
        raise RuntimeError(f"Target repository path does not exist: {repo}")

    # 1. Capture unstaged diff (git diff -U3)
    diff_unstaged = _run_git(["git", "diff", "-U3"], cwd=repo)

    # 2. Capture staged diff (git diff --cached -U3)
    diff_staged = _run_git(["git", "diff", "--cached", "-U3"], cwd=repo)

    diff_parts = []
    if diff_staged.strip():
        diff_parts.append("# === STAGED CHANGES ===\n" + diff_staged.strip())
    if diff_unstaged.strip():
        diff_parts.append("# === UNSTAGED CHANGES ===\n" + diff_unstaged.strip())

    # 3. Capture untracked files as synthetic diffs (bounded)
    untracked_files = _run_git(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=repo
    ).splitlines()

    ignored_exts = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".tar", ".gz", ".lock", ".pyc", ".map"}
    ignored_names = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"}

    if untracked_files:
        untracked_diffs = []
        for u_file in untracked_files:
            u_path = repo / u_file
            if u_path.is_symlink():
                continue
            try:
                resolved_u_path = u_path.resolve()
                resolved_u_path.relative_to(repo)
            except Exception:
                continue

            if u_path.is_file() and u_path.name not in ignored_names and u_path.suffix.lower() not in ignored_exts:
                try:
                    with open(u_path, "r", encoding="utf-8", errors="replace") as uf:
                        u_content = uf.read(10_001)
                    if len(u_content) <= 10_000:
                        untracked_diffs.append(
                            f"# === UNTRACKED FILE: {u_file} ===\n"
                            f"--- /dev/null\n"
                            f"+++ b/{u_file}\n"
                            + "\n".join(f"+{line}" for line in u_content.splitlines())
                        )
                    else:
                        untracked_diffs.append(
                            f"# === UNTRACKED FILE (TRUNCATED): {u_file} (>10k chars, omitted) ==="
                        )
                except Exception:
                    pass
        if untracked_diffs:
            diff_parts.extend(untracked_diffs)

    combined_diff = "\n\n".join(diff_parts)

    # 4. Harvest modified files context for bounded inspection
    modified_files_list = set()
    for diff_cmd in [["git", "diff", "--name-only"], ["git", "diff", "--cached", "--name-only"]]:
        try:
            names = _run_git(diff_cmd, cwd=repo).splitlines()
            for name in names:
                if name.strip():
                    modified_files_list.add(name.strip())
        except Exception:
            pass
    for u_file in untracked_files:
        if u_file.strip():
            modified_files_list.add(u_file.strip())

    file_parts = []
    for f_rel in sorted(modified_files_list):
        f_path = repo / f_rel
        if f_path.is_symlink():
            continue
        try:
            resolved_f_path = f_path.resolve()
            resolved_f_path.relative_to(repo)
        except Exception:
            continue

        if f_path.is_file() and f_path.name not in ignored_names and f_path.suffix.lower() not in ignored_exts:
            try:
                with open(f_path, "r", encoding="utf-8", errors="replace") as f_in:
                    f_content = f_in.read(10_001)
                if len(f_content) <= 10_000:
                    file_parts.append(f"### File: {f_rel}\n{f_content}")
            except Exception:
                pass

    modified_files_context = "\n\n".join(file_parts)
    return combined_diff, modified_files_context

def normalize_cacheable_text(text: str) -> str:
    """Normalize text for consistent prompt prefix caching (CRLF -> LF, strip line-end spaces, NFC)."""
    if not text:
        return ""
    normalized = unicodedata.normalize("NFC", text)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    return "\n".join(lines).strip()

def normalize_opaque_payload(text: str) -> str:
    """Normalize line endings for raw code or diff payloads without destroying indentation or trailing spaces."""
    if not text:
        return ""
    normalized = unicodedata.normalize("NFC", text)
    return normalized.replace("\r\n", "\n").replace("\r", "\n")

def build_cacheable_context(sp_template: str = "", tech_stack: str = "") -> str:
    """Return deterministic, task-independent context with canonical headings and normalized text."""
    norm_template = normalize_cacheable_text(sp_template) or "Standard implementation guidelines"
    norm_stack = normalize_cacheable_text(tech_stack) or "Standard project conventions"
    return (
        f"### Superpowers Template Framework:\n{norm_template}\n\n"
        f"### Tech Stack Guidelines:\n{norm_stack}\n"
    )

def build_architect_messages(
    task: str,
    sp_template: str = "",
    tech_stack: str = "",
    cg_context: str = ""
) -> list[dict[str, str]]:
    """Return invariant common system core prefix, architect role, stable context, then dynamic task/codegraph tail."""
    stable_context = build_cacheable_context(sp_template, tech_stack)
    
    dynamic_tail = ""
    if cg_context:
        bounded_cg = safe_truncate(cg_context, CODEGRAPH_CONTEXT_MAX_CHARS)
        dynamic_tail += f"### CodeGraph Context & Symbols (High-Signal Architectural Skeletons):\n{bounded_cg}\n\n"
    dynamic_tail += f"### User Task & Requirements:\n{task}\n"
    
    return [
        {"role": "system", "content": STATIC_COMMON_CORE_PROMPT},
        {"role": "system", "content": STATIC_ARCHITECT_ROLE_PROMPT},
        {"role": "user", "content": stable_context},
        {"role": "user", "content": dynamic_tail}
    ]

def build_auditor_messages(
    blueprint: str,
    git_diff: str,
    aqi_findings: str = "",
    test_summary: str = "",
    modified_files: str = "",
    tech_stack: str = ""
) -> list[dict[str, str]]:
    """Return invariant common system core prefix, auditor role, stable tech stack, and dynamic audit payload."""
    norm_stack = normalize_cacheable_text(tech_stack) or "Standard project conventions"
    stable_context = f"### Tech Stack & Test Framework Guidelines:\n{norm_stack}\n"
    
    bounded_blueprint = safe_truncate(blueprint, AUDIT_BLUEPRINT_MAX_CHARS)
    bounded_diff = safe_truncate(normalize_opaque_payload(_filter_git_diff(git_diff)), GIT_DIFF_MAX_CHARS)
    
    dynamic_tail = f"### Architectural Blueprint & Contracts (Stage 2 Oracle):\n{bounded_blueprint}\n\n"
    dynamic_tail += f"### Candidate Implementation Git Diff (git diff -U3):\n```diff\n{bounded_diff}\n```\n\n"
    
    if aqi_findings:
        bounded_aqi = safe_truncate(aqi_findings, AQI_FINDINGS_MAX_CHARS)
        dynamic_tail += f"### Deterministic AQI Engine AST Findings (scripts/harness/aqi/scoring.mjs):\n{bounded_aqi}\n\n"
    if test_summary:
        bounded_test = safe_truncate(test_summary, TEST_SUMMARY_MAX_CHARS)
        dynamic_tail += f"### Baseline Test Execution Results (Stage 3 CPU Output):\n{bounded_test}\n\n"
    if modified_files and MODIFIED_FILES_CONTEXT_MAX_CHARS > 0:
        bounded_files = safe_truncate(modified_files, MODIFIED_FILES_CONTEXT_MAX_CHARS)
        dynamic_tail += f"### Full Source Code of Modified Files:\n{bounded_files}\n\n"
        
    # Enforce aggregate hard ceiling across entire dynamic audit payload
    if len(dynamic_tail) > DYNAMIC_AUDIT_TOTAL_MAX_CHARS:
        dynamic_tail = safe_truncate(dynamic_tail, DYNAMIC_AUDIT_TOTAL_MAX_CHARS)
        
    return [
        {"role": "system", "content": STATIC_COMMON_CORE_PROMPT},
        {"role": "system", "content": STATIC_AUDITOR_ROLE_PROMPT},
        {"role": "user", "content": stable_context},
        {"role": "user", "content": dynamic_tail}
    ]

def is_reasoning_model(model: str) -> bool:
    """Return True if model belongs to OpenAI reasoning family (o1, o3, o4, gpt-5, gpt-6)."""
    m = model.lower()
    return any(prefix in m for prefix in ["o1", "o3", "o4", "gpt-5", "gpt-6"])

def extract_compact_test_assertions(text: str) -> list[dict[str, str]]:
    """Extract and validate compact test assertions table from model output."""

    import re
    json_matches = re.findall(r"```(?:json)?\s*(\[\s*\{.*?\}\s*\])\s*```", text, re.DOTALL)
    candidate = json_matches[-1] if json_matches else None
    if not candidate:
        raw_match = re.search(r"(\[\s*\{\s*\"in\"[\s\S]*?\}\s*\])", text)
        if raw_match:
            candidate = raw_match.group(1)
    if not candidate:
        return []
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            valid = []
            for item in parsed:
                if isinstance(item, dict) and set(item.keys()) == {"in", "out"}:
                    in_val = str(item["in"]).strip()
                    out_val = str(item["out"]).strip()
                    if in_val and out_val:
                        valid.append({"in": in_val, "out": out_val})
            if 3 <= len(valid) <= 5:
                return valid
    except Exception:
        pass
    return []

def call_openai_chat(messages, max_tokens=12000, temperature=0.2):
    if not API_KEY:
        raise ValueError("OPENAI_API_KEY is not set or found in settings.json.")
    
    url = f"{ENDPOINT.rstrip('/')}/chat/completions"
    payload = {
        "model": MODEL,
        "messages": messages,
        "max_completion_tokens": max_tokens
    }
    if is_reasoning_model(MODEL):
        payload["reasoning_effort"] = os.environ.get("OPENAI_REASONING_EFFORT", "medium")
    else:
        payload["temperature"] = temperature
    
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        },
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=360) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            content = resp_data["choices"][0]["message"]["content"]
            usage = resp_data.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)
            total_tokens = usage.get("total_tokens", 0)
            
            cached_tokens = 0
            if "prompt_tokens_details" in usage and usage["prompt_tokens_details"]:
                cached_tokens = usage["prompt_tokens_details"].get("cached_tokens", 0)
                
            reasoning_tokens = 0
            if "completion_tokens_details" in usage and usage["completion_tokens_details"]:
                reasoning_tokens = usage["completion_tokens_details"].get("reasoning_tokens", 0)
            output_tokens = max(0, completion_tokens - reasoning_tokens)
            
            if reasoning_tokens > 0:
                output_str = f"Content: {output_tokens} | Thinking: {reasoning_tokens}"
            else:
                output_str = f"Content: {output_tokens}"
                
            uncached_prompt = max(0, prompt_tokens - cached_tokens)
            cost_micro_usd = int(cached_tokens * 0.10 + uncached_prompt * 2.00 + completion_tokens * 10.00)
            cost_usd_str = f"${cost_micro_usd / 1_000_000:.4f}"

            cache_info = f" (Cached: {cached_tokens})" if cached_tokens > 0 else ""
            usage_str = (
                f"\n\n---\n"
                f"📊 [GPT Token Usage]: "
                f"Input: {prompt_tokens}{cache_info} | "
                f"Output: {output_str} | "
                f"Total: {total_tokens} | "
                f"Cost: {cost_usd_str} ({cost_micro_usd} µUSD)"
            )
                
            return content + usage_str
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        raise RuntimeError(f"OpenAI API error {e.code}: {error_body}")
    except Exception as e:
        raise RuntimeError(f"Request failed: {str(e)}")

def handle_rpc_request(request):
    req_id = request.get("id")
    method = request.get("method")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "gpt_architect",
                    "version": "3.0.2"
                }
            }
        }
    elif method == "notifications/initialized":
        return None
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "craft_technical_prompt_with_gpt",
                        "description": "Stage 2 Prompt Architect: Compiles requirements, tech stack, and CodeGraph topological skeletons into a definitive blueprint and golden test assertions for Gemini 3.8 Flash.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "task_description": {
                                    "type": "string",
                                    "description": "User requirement or functionality to implement/fix/refactor."
                                },
                                "superpowers_template": {
                                    "type": "string",
                                    "description": "Superpowers template guidelines (e.g. implementer-prompt.md, writing-plans)."
                                },
                                "codegraph_context": {
                                    "type": "string",
                                    "description": "High-signal architectural context extracted from CodeGraph (3,000 - 6,000 tokens): target symbols, type interfaces, data schemas, and caller topology."
                                },
                                "project_tech_stack": {
                                    "type": "string",
                                    "description": "Project tech stack, coding conventions, or architecture patterns."
                                }
                            },
                            "required": ["task_description"]
                        }
                    },
                    {
                        "name": "audit_and_break_code_with_gpt",
                        "description": "Stage 4 Adversarial QA & AQI Doctor: Read-only audit of candidate git diff and modified files against Stage 2 blueprint and deterministic AQI findings. Auto-harvests git diff and modified files if omitted. Generates executable adversarial tests and surgical remediation prescriptions.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "blueprint": {
                                    "type": "string",
                                    "description": "Original technical blueprint and target file contracts established in Stage 2. If omitted, automatically loaded from latest Stage 2 execution or .ai/blueprint.md."
                                },
                                "git_diff": {
                                    "type": "string",
                                    "description": "The candidate code changes from Stage 3 (git diff -U3). If omitted, automatically harvested via git diff."
                                },
                                "aqi_findings": {
                                    "type": "string",
                                    "description": "Raw AST findings or report from local AQI compliance engine (node scripts/harness/aqi.mjs)."
                                },
                                "test_summary": {
                                    "type": "string",
                                    "description": "Summary of baseline test execution results from Stage 3."
                                },
                                "modified_files_context": {
                                    "type": "string",
                                    "description": "Full source code of modified files to give the auditor complete lifecycle visibility (up to 15,000 tokens). If omitted, automatically harvested from modified files."
                                },
                                "repo_path": {
                                    "type": "string",
                                    "description": "Optional path to the git repository root. Defaults to auto-resolving from current working directory."
                                },
                                "project_tech_stack": {
                                    "type": "string",
                                    "description": "Project tech stack and testing framework (e.g. Node:test, Jest, Vitest, Pytest)."
                                }
                            },
                            "required": []
                        }
                    }
                ]
            }
        }
    elif method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments", {})
        
        if tool_name == "craft_technical_prompt_with_gpt":
            task = args.get("task_description", "")
            sp_template = args.get("superpowers_template", "")
            cg_context = args.get("codegraph_context", "")
            tech_stack = args.get("project_tech_stack", "")
            
            messages = build_architect_messages(
                task=task,
                sp_template=sp_template,
                tech_stack=tech_stack,
                cg_context=cg_context
            )
            
            try:
                result_text = call_openai_chat(messages, max_tokens=12000)
                assertions = extract_compact_test_assertions(result_text)
                if 3 <= len(assertions) <= 5 and "COMPACT_TEST_ASSERTIONS_JSON:" not in result_text:
                    canonical_json = json.dumps(assertions, ensure_ascii=False, separators=(",", ":"))
                    result_text += f"\n\nCOMPACT_TEST_ASSERTIONS_JSON:\n{canonical_json}"

                # Cache blueprint in memory for Stage 4 Zero-Payload auto-fallback
                global LATEST_BLUEPRINT
                LATEST_BLUEPRINT = result_text

                # Attempt to persist blueprint to repo .ai directory atomically
                try:
                    repo_root = _find_repo_root()
                    _safe_persist_file(repo_root / ".ai" / "blueprint.md", result_text)
                except Exception:
                    pass

                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": result_text
                            }
                        ]
                    }
                }
            except Exception as e:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32603,
                        "message": str(e)
                    }
                }
                
        elif tool_name == "audit_and_break_code_with_gpt":
            blueprint = args.get("blueprint", "").strip()
            git_diff = args.get("git_diff", "").strip()
            aqi_findings = args.get("aqi_findings", "").strip()
            test_summary = args.get("test_summary", "").strip()
            modified_files = args.get("modified_files_context", "").strip()
            tech_stack = args.get("project_tech_stack", "").strip()
            repo_path = args.get("repo_path", "").strip()

            # 1. Resolve repository root
            try:
                root = Path(repo_path).resolve() if repo_path else _find_repo_root()
            except Exception:
                root = None

            # 2. Auto-fallback for blueprint if missing
            if not blueprint:
                if LATEST_BLUEPRINT:
                    blueprint = LATEST_BLUEPRINT
                elif root:
                    disk_bp = root / ".ai" / "blueprint.md"
                    if disk_bp.is_file():
                        try:
                            with open(disk_bp, "r", encoding="utf-8") as f:
                                blueprint = f.read()
                        except Exception:
                            pass

            if not blueprint:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32602,
                        "message": "Blueprint is required. Provide 'blueprint' or run 'craft_technical_prompt_with_gpt' first."
                    }
                }

            # 3. Auto-harvest git context if git_diff missing (Diff-First mandate)
            if not git_diff:
                if not root:
                    return {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32603,
                            "message": "Cannot auto-harvest git context: not inside a git repository and no 'repo_path' provided."
                        }
                    }
                try:
                    harvested_diff, harvested_files = _harvest_git_context(root)
                    git_diff = harvested_diff
                    if not modified_files and MODIFIED_FILES_CONTEXT_MAX_CHARS > 0:
                        modified_files = harvested_files
                except Exception as e:
                    return {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32603,
                            "message": f"Git auto-harvesting failed: {str(e)}"
                        }
                    }

            if not git_diff.strip() and not modified_files.strip():
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32602,
                        "message": "No code changes found to audit. Working directory has no staged, unstaged, or untracked modifications."
                    }
                }

            messages = build_auditor_messages(
                blueprint=blueprint,
                git_diff=git_diff,
                aqi_findings=aqi_findings,
                test_summary=test_summary,
                modified_files=modified_files,
                tech_stack=tech_stack
            )
            
            try:
                result_text = call_openai_chat(messages, max_tokens=16000)
                if root:
                    _safe_persist_file(root / ".ai" / "audit.md", result_text)
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": result_text
                            }
                        ]
                    }
                }
            except Exception as e:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32603,
                        "message": str(e)
                    }
                }
        else:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32601,
                    "message": f"Tool not found: {tool_name}"
                }
            }
    elif method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {}
        }
    else:
        if req_id is not None:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            }
        return None

def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle_rpc_request(req)
            if resp is not None:
                sys.stdout.write(json.dumps(resp) + "\n")
                sys.stdout.flush()
        except Exception as e:
            err_resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {str(e)}"
                }
            }
            sys.stdout.write(json.dumps(err_resp) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
