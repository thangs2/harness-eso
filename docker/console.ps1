# Harness Console — product wizard API + SPA (monorepo only)
#Requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'up', 'start', 'down', 'restart', 'status', 'ps', 'health', 'logs', 'dev', 'help')]
    [string] $Command = 'help',

    [switch] $NoBuild,
    [switch] $Foreground,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Rest
)

$ErrorActionPreference = 'Stop'

$DockerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EsoRoot = (Resolve-Path (Join-Path $DockerDir '..')).Path
$Cli = Join-Path $EsoRoot 'packages\harness-cli\src\cli.mjs'

function Die([string] $Message) {
    Write-Error "console.ps1: $Message"
    exit 1
}

function Require-Cli {
    if (-not (Test-Path -LiteralPath $Cli)) { Die "missing $Cli — run from harness-eso clone" }
    if (-not (Test-Path -LiteralPath (Join-Path $EsoRoot 'node_modules'))) {
        Die "missing node_modules — run: cd $EsoRoot && bun install"
    }
}

function Invoke-Console([string[]] $SubArgs) {
    Require-Cli
    $all = @('console') + $SubArgs
    & node $Cli @all
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Cmd-Build {
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Host '==> bun run build:console (host verify)'
        Push-Location $EsoRoot
        try {
            & bun run build:console
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host '==> skip host build (no bun); image build runs build:console inside Docker'
    }
    Write-Host '==> docker compose build (console image)'
    Invoke-Console @('build')
}

function Cmd-Up {
    $extra = @()
    if ($NoBuild) { $extra += '--no-build' }
    if ($Foreground) { $extra += '--foreground' }
    if ($Rest) { $extra += $Rest }
    $sub = @('up') + $extra
    Invoke-Console $sub
}

function Cmd-Restart {
    Invoke-Console @('down')
    Cmd-Up
}

$cmd = if ($Command -eq 'start') { 'up' } else { $Command }

switch ($cmd) {
    'build' { Cmd-Build }
    'up' { Cmd-Up }
    'restart' { Cmd-Restart }
    'down' { Invoke-Console (@('down') + $Rest) }
    'status' { Invoke-Console (@('status') + $Rest) }
    'ps' { Invoke-Console (@('status') + $Rest) }
    'health' { Invoke-Console (@('health') + $Rest) }
    'logs' { Invoke-Console (@('logs') + $Rest) }
    'dev' {
        Die "dev mode removed from console.ps1 — use Docker: console.ps1 up (or local: node packages/harness-console-server/src/server.mjs)"
    }
    'help' {
        Write-Host "usage: console.ps1 build | up [--no-build] [--foreground] | down | restart | status | health | logs"
    }
}
