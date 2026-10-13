# [03] Verify Observatory API + tenant
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Port = if ($env:HARNESS_OBSERVE_PORT) { $env:HARNESS_OBSERVE_PORT } else { '8792' }
$Base = "http://127.0.0.1:${Port}"

function Die([string] $Message) {
    Write-Error "[03.verify-observatory] $Message"
    exit 1
}

Write-Host "==> [03] GET ${Base}/health"
curl.exe -fsS "${Base}/health"
if ($LASTEXITCODE -ne 0) { Die 'health failed — run .\01.observatory-up.ps1 first' }
Write-Host ''

Write-Host "==> [03] GET ${Base}/api/tenant"
curl.exe -fsS "${Base}/api/tenant"
Write-Host ''
Write-Host ''
Write-Host "[03] OK — open ${Base}/requests after IDE prompt on consumer."
