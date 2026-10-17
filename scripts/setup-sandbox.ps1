# scripts/setup-sandbox.ps1
# Idempotent setup and health-check script for kins_autonomous_sandbox container.
# Compatible with Windows PowerShell 5.1+ and PowerShell Core 7+.

param(
  [Parameter(Mandatory = $false)]
  [string] $Image = "node:22-bookworm-slim"
)

$ErrorActionPreference = "Continue"

Write-Host "[Kin's Cockpit] Probing Docker daemon..." -ForegroundColor Cyan

# 1. Probe Docker Daemon responsiveness
$dockerInfo = docker info --format '{{.ServerVersion}}' 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] Docker Desktop daemon is offline or not installed." -ForegroundColor Red
  Write-Host "Please start Docker Desktop, wait for the engine to initialize, and retry." -ForegroundColor Yellow
  exit 1
}

$containerName = "kins_autonomous_sandbox"

# 2. Check if container already exists
$runningState = docker inspect --format '{{.State.Running}}' $containerName 2>&1
$inspectCode = $LASTEXITCODE

if ($inspectCode -eq 0) {
  $trimmedState = ($runningState -as [string]).Trim().ToLower()
  if ($trimmedState -eq "true") {
    Write-Host "[OK] Container '$containerName' is already active and responsive." -ForegroundColor Green
    exit 0
  } else {
    Write-Host "[INFO] Container '$containerName' exists but is stopped. Starting container..." -ForegroundColor Yellow
    docker start $containerName | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[OK] Container '$containerName' started successfully." -ForegroundColor Green
      exit 0
    } else {
      Write-Host "[ERROR] Failed to start stopped container '$containerName'." -ForegroundColor Red
      exit 1
    }
  }
}

# 3. Create container if missing
Write-Host "[INFO] Container '$containerName' not found. Creating autonomous sandbox container ($Image)..." -ForegroundColor Cyan
$currentDir = (Get-Location).Path

docker run -d `
  --name $containerName `
  --restart unless-stopped `
  -v "${currentDir}:/workspace" `
  -w /workspace `
  $Image `
  tail -f /dev/null

if ($LASTEXITCODE -eq 0) {
  Write-Host "[OK] Sandbox container '$containerName' successfully created and running." -ForegroundColor Green
  exit 0
} else {
  Write-Host "[ERROR] Failed to create sandbox container '$containerName'." -ForegroundColor Red
  exit 1
}
