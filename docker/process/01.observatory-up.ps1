# [01] Observatory Docker — build + up + health
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$ProcessDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EsoRoot = (Resolve-Path (Join-Path $ProcessDir '..\..')).Path

& (Join-Path $ProcessDir '00.docker-check.ps1')
if (-not $env:HARNESS_AGENT_ROOT) {
    $env:HARNESS_AGENT_ROOT = Join-Path $env:USERPROFILE 'Workspaces'
}

$Port = if ($env:HARNESS_OBSERVE_PORT) { $env:HARNESS_OBSERVE_PORT } else { '8792' }

Write-Host '==> [01] observatory build'
& (Join-Path $EsoRoot 'docker\observatory.ps1') build

Write-Host '==> [01] harness observatory up'
Push-Location $EsoRoot
& node (Join-Path $EsoRoot 'packages\harness-cli\src\cli.mjs') observatory up
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Pop-Location

$HealthUrl = "http://127.0.0.1:${Port}/health"
Write-Host "==> [01] GET $HealthUrl"
curl.exe -fsS $HealthUrl
Write-Host ''
Write-Host "[01] OK — Observatory http://127.0.0.1:${Port}/"
Write-Host '[01] Next (new terminal): cd docker\process; .\02.console-up.ps1'
