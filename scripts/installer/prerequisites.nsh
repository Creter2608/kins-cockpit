; scripts/installer/prerequisites.nsh
; Kin's Cockpit - NSIS Prerequisite Disclosure & Transparency Hook
; This hook is included by electron-builder during NSIS wizard generation.
; It discloses mandatory external system prerequisites before installation begins:
; 1. Git (version control & worktree isolation)
; 2. External Node.js >= 22 (autonomous task runtime, separate from embedded Electron Node)
; 3. Docker Desktop & container: kins_autonomous_sandbox (OS-level container containment)
; 4. Antigravity CLI (agent orchestration and telemetry harness)
; 5. OpenAI API Key (GPT Oracle Stage 2 Blueprint & Stage 4 Audit)
; 6. CodeGraph CLI (AST indexing & semantic navigation engine)
;
; Provides explicit Cancel abort mechanism before touching host filesystem.

ManifestDPIAware true

!macro customInit
  ; Display prerequisite disclosure with explicit Cancel option
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION \
    "Welcome to the Kin's Cockpit Setup Wizard!$\r$\n$\r$\n\
    The application requires the following external tools for full autonomous cockpit functionality:$\r$\n\
    • Git: Version control and worktree isolation.$\r$\n\
    • Node.js >= 22: External autonomous loop execution runtime.$\r$\n\
    • Docker: Container isolation with kins_autonomous_sandbox.$\r$\n\
    • Antigravity: Agent orchestration CLI and telemetry HUD.$\r$\n\
    • OpenAI API Key: GPT Oracle Stage 2 Blueprint and Stage 4 Reality Check.$\r$\n\
    • CodeGraph AST Engine: AST indexing and structural code navigation engine.$\r$\n$\r$\n\
    After installation, you can inspect and configure each component via the in-app System Readiness Check.$\r$\n$\r$\n\
    Click OK to continue setup and choose installation directory.$\r$\n\
    Click CANCEL if you do not wish to install at this time." \
    IDOK continue_setup IDCANCEL abort_setup

abort_setup:
  Abort

continue_setup:
!macroend
