/**
 * src/main/services/ReadinessTerminalService.ts
 * Trusted resolver and launcher for preflight prerequisite installations in external interactive terminals.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { InstallablePrerequisiteId } from "../../shared/systemReadiness.js";

export const WINDOWS_AGY_INSTALL_CMD = "irm https://antigravity.google/cli/install.ps1 | iex";
export const WINDOWS_CODEGRAPH_INSTALL_CMD = "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex";

export function getPrerequisiteInstallCommand(
  id: InstallablePrerequisiteId,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform === "win32") {
    if (id === "antigravity") return WINDOWS_AGY_INSTALL_CMD;
    if (id === "codegraph") return WINDOWS_CODEGRAPH_INSTALL_CMD;
  } else if (platform === "darwin" || platform === "linux") {
    if (id === "antigravity") return "curl -fsSL https://antigravity.google/cli/install.sh | bash";
    if (id === "codegraph") return "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | bash";
  }
  return undefined;
}

export async function executeReadinessInstallInTerminal(
  id: InstallablePrerequisiteId,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (id !== "antigravity" && id !== "codegraph") {
    throw new Error(`Unsupported prerequisite ID for terminal installation: ${String(id)}`);
  }

  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported platform for terminal launch: ${String(platform)}`);
  }

  const command = getPrerequisiteInstallCommand(id, platform);
  if (!command) {
    throw new Error(`No automated installation command available for ${id} on platform ${platform}`);
  }

  return new Promise<void>((resolve, reject) => {
    try {
      let child: ChildProcess;
      if (platform === "win32") {
        child = spawn(
          "powershell.exe",
          ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command],
          {
            detached: true,
            stdio: "ignore",
            windowsHide: false
          }
        );
      } else if (platform === "darwin") {
        const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        child = spawn("/usr/bin/osascript", ["-e", `tell application "Terminal" to do script "${escaped}"`], {
          detached: true,
          stdio: "ignore"
        });
      } else {
        child = spawn("x-terminal-emulator", ["-e", "bash", "-c", `${command}; exec bash`], {
          detached: true,
          stdio: "ignore"
        });
      }

      let settled = false;

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on("spawn", () => {
        if (!settled) {
          settled = true;
          try {
            child.unref();
          } catch {
            // Ignore unref failures if detached is already handled
          }
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
