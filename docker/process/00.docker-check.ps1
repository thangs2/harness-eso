# [00] Prerequisites — Docker daemon + bun
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$ProcessDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EsoRoot = (Resolve-Path (Join-Path $ProcessDir '..\..')).Path

function Die([string] $Message) {
    Write-Error "[00.docker-check] $Message"
    exit 1
}

Write-Host "==> [00] harness-eso root: $EsoRoot"
if (-not (Test-Path -LiteralPath (Join-Path $EsoRoot 'package.json'))) {
    Die 'not harness-eso root (missing package.json)'
}

docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Die 'Docker daemon not running — start Docker Desktop, then re-run .\01.observatory-up.ps1'
}
Write-Host '==> [00] Docker: OK'

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Die 'bun not found — install bun for host observatory build'
}
Write-Host '==> [00] bun: OK'

if (-not (Test-Path -LiteralPath (Join-Path $EsoRoot 'node_modules'))) {
    Die "run once: cd $EsoRoot && bun install"
}
Write-Host '==> [00] node_modules: OK'
Write-Host '[00] OK — next: .\01.observatory-up.ps1'
