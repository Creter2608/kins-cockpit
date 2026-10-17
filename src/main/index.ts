import { isAllowedNavigation } from "./navigation.js";
import { app, BrowserWindow, session } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PtyService } from "./services/PtyService.js";
import { LoopStateService } from "./services/LoopStateService.js";
import { McpMonitorService } from "./services/McpMonitorService.js";
import { CriticalLogService } from "./services/CriticalLogService.js";
import { TelemetryService } from "./services/TelemetryService.js";
import { DockerStatusService } from "./services/DockerStatusService.js";
import { SystemReadinessService } from "./services/SystemReadinessService.js";
import { RollbackService } from "./services/RollbackService.js";
import { TranscriptIngestionService } from "./services/TranscriptIngestionService.js";
import { WorktreeAttributionService } from "./services/WorktreeAttributionService.js";
import { ProjectService } from "./services/ProjectService.js";
import { EvalHarnessService } from "./services/EvalHarnessService.js";
import { SubagentService } from "./services/SubagentService.js";
import { PreToolUseHookService } from "./services/preToolUseHookService.js";
import { HarnessService } from "./services/HarnessService.js";
import { ContextOptimizationService } from "./services/ContextOptimizationService.js";
import { ProviderCapacityService } from "./services/ProviderCapacityService.js";
import { EccCatalogService } from "./services/EccCatalogService.js";
import { EccDispatcherService } from "./services/EccDispatcherService.js";
import { SUBAGENT_IPC_CHANNELS } from "../shared/contracts.js";
import { registerIpcHandlers } from "./ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let teardownIpc: (() => void) | null = null;

// Determine absolute project repository root
const isPackaged = app.isPackaged;
const appInstallRoot = isPackaged
  ? path.dirname(app.getPath("exe"))
  : path.resolve(__dirname, "../../..");

// Writable safe landing workspace under userData when no recent project is selected
const defaultWorkspaceRoot = isPackaged
  ? path.join(app.getPath("userData"), "workspace")
  : path.resolve(__dirname, "../../..");

if (isPackaged && !fs.existsSync(defaultWorkspaceRoot)) {
  try {
    fs.mkdirSync(defaultWorkspaceRoot, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to initialize default cockpit workspace at ${defaultWorkspaceRoot}`, { cause: err });
  }
}

const projectRoot = defaultWorkspaceRoot;

// Instantiate backend services with deterministic absolute paths
const ptyService = new PtyService(projectRoot);
const loopService = new LoopStateService(path.join(projectRoot, ".ai", "state.json"), projectRoot);
const mcpService = new McpMonitorService(projectRoot);
const logService = new CriticalLogService();
const telemetryService = new TelemetryService();
const dockerService = new DockerStatusService();
const systemReadinessService = new SystemReadinessService(dockerService);
const rollbackService = new RollbackService(projectRoot, appInstallRoot);
const evalService = new EvalHarnessService(projectRoot, appInstallRoot);
const subagentService = new SubagentService();
const preToolUseHookService = new PreToolUseHookService();
const worktreeService = new WorktreeAttributionService();
const contextOptimizationService = new ContextOptimizationService();
const providerCapacityService = new ProviderCapacityService();

// Resolves bundled ECC first, then env or local sibling path
const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
const bundledEccPath = resourcesPath && fs.existsSync(path.join(resourcesPath, "bundled", "ecc"))
  ? path.join(resourcesPath, "bundled", "ecc")
  : (fs.existsSync(path.resolve(__dirname, "../../resources/bundled/ecc"))
    ? path.resolve(__dirname, "../../resources/bundled/ecc")
    : path.resolve(projectRoot, "resources/bundled/ecc"));
const eccCatalogPath = process.env.ECC_PATH ||
  (fs.existsSync(bundledEccPath) ? bundledEccPath : path.resolve(projectRoot, "../ECC"));
const eccCatalogService = new EccCatalogService(eccCatalogPath);
const eccDispatcherService = new EccDispatcherService(eccCatalogService, subagentService);
const transcriptService = new TranscriptIngestionService(telemetryService, mcpService, loopService, null, subagentService);
transcriptService.setWorktreeAttributionService(worktreeService);
let projectService: ProjectService | null = null;
let harnessService: HarnessService | null = null;

// Connect docker status updates to telemetry service
dockerService.subscribe((status) => {
  telemetryService.updateDockerStatus(status);
});

// Connect provider capacity updates to telemetry service
providerCapacityService.subscribe((capacities) => {
  telemetryService.updateProviderCapacity(capacities);
});

function setupSecurityHeaders(): void {
  const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
  let devWs = "";
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    try {
      const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
      devWs = " ws://" + devUrl.host + " wss://" + devUrl.host + " " + devUrl.origin;
    } catch {}
  }
  const csp = isDev
    ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'" + devWs + "; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none';"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none';";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === "content-security-policy") {
        delete responseHeaders[key];
      }
    }
    responseHeaders["Content-Security-Policy"] = [csp];
    callback({ responseHeaders });
  });
}

async function createWindow(): Promise<void> {
  if (!harnessService) {
    harnessService = new HarnessService(
      path.join(app.getPath("userData"), "harness"),
      loopService.getSnapshot().runId || "default-run"
    );
    transcriptService.setHarnessService(harnessService);
  }

  if (!projectService) {
    projectService = new ProjectService(
      path.join(app.getPath("userData"), "recent-projects.json"),
      projectRoot,
      {
        ptyService,
        loopStateService: loopService,
        mcpMonitorService: mcpService,
        rollbackService,
        evalHarnessService: evalService,
        telemetryService,
        transcriptService,
        subagentService,
        logService,
        preToolUseHookService
      }
    );
    await projectService.initialize();
  }

  const preloadPath = path.resolve(__dirname, "../preload/index.cjs");
  if (!fs.existsSync(preloadPath)) {
    console.error(`[CRITICAL] Preload artifact missing at: ${preloadPath}`);
  }

  const assetsDir = resourcesPath && fs.existsSync(path.join(resourcesPath, "assets"))
    ? path.join(resourcesPath, "assets")
    : path.resolve(projectRoot, "assets");
  const iconIco = path.join(assetsDir, "icon.ico");
  const iconPng = path.join(assetsDir, "icon.png");
  const iconSvg = path.join(assetsDir, "icon.svg");
  const iconPath = fs.existsSync(iconIco)
    ? iconIco
    : (fs.existsSync(iconPng) ? iconPng : (fs.existsSync(iconSvg) ? iconSvg : undefined));

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#000000",
    title: "Kin's Cockpit",
    titleBarStyle: "hiddenInset",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Security Invariants: Deny opening new windows and restrict navigation
  const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
  const devServerUrl = isDev ? process.env.VITE_DEV_SERVER_URL! : null;
  const indexPath = path.resolve(__dirname, "../../renderer/index.html");
  const allowedEntryUrl = devServerUrl ?? pathToFileURL(indexPath).href;

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isAllowedNavigation(navigationUrl, allowedEntryUrl)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isAllowedNavigation(event.url, allowedEntryUrl)) {
      event.preventDefault();
    }
  });

  // Diagnostics for preload & renderer loading
  mainWindow.webContents.on("preload-error", (_event, pPath, error) => {
    console.error(`[Preload Error] Failed to load ${pPath}:`, error);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`[Renderer Load Error] Code: ${errorCode}, Description: ${errorDescription}`);
  });

  // Start background monitoring services
  loopService.start();
  mcpService.start();
  logService.start();
  dockerService.start();
  transcriptService.start();
  void evalService.start();

  teardownIpc = registerIpcHandlers(mainWindow, {
    project: projectService!,
    pty: ptyService,
    loop: loopService,
    mcp: mcpService,
    logs: logService,
    telemetry: telemetryService,
    rollback: rollbackService,
    evalHarness: evalService,
    subagents: subagentService,
    harness: harnessService,
    contextOptimization: contextOptimizationService,
    providerCapacity: providerCapacityService,
    eccCatalog: eccCatalogService,
    eccDispatcher: eccDispatcherService,
    systemReadiness: systemReadinessService
  });

  // Push immediate snapshots as soon as renderer is ready
  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("loop:snapshot", loopService.getSnapshot());
      mainWindow.webContents.send("mcp:snapshot", mcpService.getSnapshot());
      mainWindow.webContents.send("logs:entries", logService.getSnapshot().entries);
      mainWindow.webContents.send("telemetry:snapshot", telemetryService.getSnapshot());
      mainWindow.webContents.send("eval:snapshot", evalService.getSnapshot());
      mainWindow.webContents.send(SUBAGENT_IPC_CHANNELS.changed, subagentService.list());
      if (harnessService) {
        void harnessService.getEvents().then((events) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("harness:snapshot", events);
          }
        });
      }
    }
  });

  // Load window entry URL
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(indexPath).catch((err) => {
      console.error("Failed to load index.html:", err);
    });
  }

  // Allow F12 to toggle DevTools for inspection
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  app.setName("Kin's Cockpit");
  if (process.platform === "win32") {
    app.setAppUserModelId("com.kins.cockpit");
  }
  setupSecurityHeaders();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (teardownIpc) {
    teardownIpc();
  }
  ptyService.dispose();
  loopService.dispose();
  mcpService.dispose();
  logService.dispose();
  dockerService.dispose();
  systemReadinessService.dispose();
  telemetryService.dispose();
  transcriptService.dispose();
  eccCatalogService.dispose();
  void evalService.dispose();
  void harnessService?.dispose();
});

process.on("uncaughtException", (error) => {
  console.error("[CRITICAL] Main process uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL] Main process unhandledRejection:", reason);
});
