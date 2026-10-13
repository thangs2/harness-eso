# Harness Observatory — Docker stack (API + SPA on :8792)
#Requires -Version 5.1
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'up', 'start', 'down', 'restart', 'status', 'health', 'logs', 'smoke', 'help')]
    [string] $Command = 'help',

    [Parameter(Position = 1)]
    [string] $ConsumerRepo = '',

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
    Write-Error "observatory.ps1: $Message"
    exit 1
}

function Require-Cli {
    if (-not (Test-Path -LiteralPath $Cli)) { Die "missing $Cli — run from harness-eso clone" }
    if (-not (Test-Path -LiteralPath (Join-Path $EsoRoot 'node_modules'))) {
        Die "missing node_modules — run: cd $EsoRoot && bun install"
    }
}

function Invoke-Observatory([string[]] $SubArgs) {
    Require-Cli
    $all = @('observatory') + $SubArgs
    & node $Cli @all
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Set-Consumer([string] $Path) {
    if (-not $Path) { return }
    $cfg = Join-Path $Path 'harness.config.json'
    if (-not (Test-Path -LiteralPath $cfg)) { Die "no harness.config.json in $Path" }
    $env:HARNESS_REPO_ROOT = (Resolve-Path $Path).Path
}

function Cmd-Build {
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Host '==> bun run build:observatory (host verify)'
        Push-Location $EsoRoot
        try {
            & bun run build:observatory
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host '==> skip host build (no bun); Docker image runs build:observatory'
    }
    Write-Host '==> docker compose build'
    Invoke-Observatory @('build')
}

function Cmd-Up {
    Set-Consumer $ConsumerRepo
    $upArgs = @('up')
    if ($NoBuild) { $upArgs += '--no-build' }
    if ($Foreground) { $upArgs += '--foreground' }
    if ($Rest) { $upArgs += $Rest }
    Invoke-Observatory $upArgs
}

function Cmd-Restart {
    Set-Consumer $ConsumerRepo
    Invoke-Observatory @('down')
    Cmd-Up
}

$cmd = if ($Command -eq 'start') { 'up' } else { $Command }

switch ($cmd) {
    'build' { Cmd-Build }
    'up' { Cmd-Up }
    'down' { Invoke-Observatory @('down') + $Rest }
    'restart' { Cmd-Restart }
    'status' { Invoke-Observatory @('status') + $Rest }
    'health' { Invoke-Observatory @('health') + $Rest }
    'logs' { Invoke-Observatory @('logs') + $Rest }
    'smoke' { Invoke-Observatory @('smoke') + $Rest }
    'help' {
        Get-Content $MyInvocation.MyCommand.Path -TotalCount 16 | ForEach-Object {
            if ($_ -match '^#') { $_.TrimStart('#').Trim() }
        }
    }
}
