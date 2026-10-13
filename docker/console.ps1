# Harness Console — product wizard API + SPA (monorepo only)
#Requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'up', 'start', 'dev', 'health', 'help')]
    [string] $Command = 'help'
)

$ErrorActionPreference = 'Stop'

$DockerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EsoRoot = (Resolve-Path (Join-Path $DockerDir '..')).Path
$Server = Join-Path $EsoRoot 'packages\harness-console-server\src\server.mjs'

$ConsoleHost = if ($env:HARNESS_CONSOLE_HOST) { $env:HARNESS_CONSOLE_HOST } else { '127.0.0.1' }
$ConsolePort = if ($env:HARNESS_CONSOLE_PORT) { $env:HARNESS_CONSOLE_PORT } else { '8791' }

function Die([string] $Message) {
    Write-Error "console.ps1: $Message"
    exit 1
}

function Require-Eso {
    if (-not (Test-Path -LiteralPath $Server)) { Die "missing $Server — run from harness-eso clone" }
    if (-not (Test-Path -LiteralPath (Join-Path $EsoRoot 'node_modules'))) {
        Die "missing node_modules — run: cd $EsoRoot && bun install"
    }
}

function Require-Bun {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Die 'cần bun (bun.sh)' }
}

function Ensure-ProductState {
    $h = Join-Path $EsoRoot '.harness'
    New-Item -ItemType Directory -Force -Path $h | Out-Null
    $ws = Join-Path $h 'workspace.json'
    if (-not (Test-Path -LiteralPath $ws)) {
        '{"version":1,"defaultProjectId":null,"projects":[]}' | Set-Content -LiteralPath $ws -Encoding utf8
    }
}

function Test-Dist {
    Test-Path -LiteralPath (Join-Path $EsoRoot 'packages\harness-console\dist\index.html')
}

function Free-Port {
    $conns = Get-NetTCPConnection -LocalPort $ConsolePort -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

function Cmd-Build {
    Require-Eso
    Require-Bun
    Write-Host '==> bun run build:console'
    Push-Location $EsoRoot
    try {
        & bun run build:console
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
}

function Cmd-Up {
    Require-Eso
    Ensure-ProductState
    if (-not (Test-Dist)) {
        Write-Host '==> no packages/harness-console/dist — building'
        Cmd-Build
    }
    Free-Port
    Write-Host "==> Harness Console http://${ConsoleHost}:${ConsolePort}"
    & node $Server
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Cmd-Dev {
    Require-Eso
    Require-Bun
    Ensure-ProductState
    Free-Port
    Write-Host "==> API http://${ConsoleHost}:${ConsolePort} (background)"
    $api = Start-Process -FilePath 'node' -ArgumentList $Server -PassThru -WorkingDirectory $EsoRoot
    Start-Sleep -Milliseconds 300
    $env:HARNESS_CONSOLE_URL = "http://${ConsoleHost}:${ConsolePort}"
    Write-Host '==> Vite dev (proxy /api → console server)'
    Push-Location (Join-Path $EsoRoot 'packages\harness-console')
    try {
        & bun run dev
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
        if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue }
    }
}

function Cmd-Health {
    Require-Eso
    $url = "http://${ConsoleHost}:${ConsolePort}/health"
    try {
        $r = Invoke-RestMethod -Uri $url -Method Get
        $r | ConvertTo-Json -Compress
        Write-Host ''
    } catch {
        Die "health failed: $url — is console.sh up running?"
    }
}

$cmd = if ($Command -eq 'start') { 'up' } else { $Command }

switch ($cmd) {
    'build' { Cmd-Build }
    'up' { Cmd-Up }
    'dev' { Cmd-Dev }
    'health' { Cmd-Health }
    'help' {
        Get-Content $MyInvocation.MyCommand.Path -TotalCount 12 | ForEach-Object {
            if ($_ -match '^#') { $_.TrimStart('#').Trim() }
        }
    }
}
