# [02] Harness Console — wizard (foreground :8791)
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$ProcessDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EsoRoot = (Resolve-Path (Join-Path $ProcessDir '..\..')).Path
$Port = if ($env:HARNESS_CONSOLE_PORT) { $env:HARNESS_CONSOLE_PORT } else { '8791' }

Write-Host "==> [02] Console http://127.0.0.1:${Port}/"
Write-Host '[02] Wizard: init/provision consumer. Bước 1 (Observatory) must be healthy first.'
Write-Host ''

& (Join-Path $EsoRoot 'docker\console.ps1') up
