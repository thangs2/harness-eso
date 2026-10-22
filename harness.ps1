#Requires -Version 5.1
<#
.SYNOPSIS
    Windows entrypoints for the harness-eso operator surface.

.DESCRIPTION
    Four scripts on macOS/Linux drive every operator action: deploy.sh, provision.sh,
    verify-consumer.sh, console.sh. This file is the same four for Windows, and it is deliberately
    *thin*: it finds a bash (Git Bash, or WSL) and hands argv to the real script. All logic —
    registry reads, exit codes, port resolution — stays in one place, so a behaviour fixed in the .sh
    is fixed on Windows the moment it lands.

    Re-implementing the resolution here in PowerShell would be a second definition of "which consumer",
    and the two would drift exactly like the shell scripts drifted from registry v2: they kept reading
    `p.port` after the port moved to `p.observe.port`, and reported 8792 for every project.

    Prerequisites on Windows: Docker Desktop, Bun, Node, and Git for Windows (which ships bash).
    WSL works too: set HARNESS_WSL=1.

.PARAMETER Command
    deploy | provision | verify | console

    deploy     ./deploy.sh     <consumer|all> [--plan] [--no-build] [--smoke]
    provision  ./provision.sh  <consumer|all> [--plan] [--force] [--host-mode <mode>]
    verify     ./verify-consumer.sh <consumer|all> [--json] [--strict] [--out <dir>]
    console    ./console.sh    [up|restart|down|status|health|logs|build|verify|smoke]

.PARAMETER Rest
    Everything after the command, forwarded verbatim. Keep shell quoting in mind: values with spaces
    need quotes on the PowerShell side too.

.EXAMPLE
    ./harness.ps1 provision x79 --plan
    ./harness.ps1 verify x79 --json
    ./harness.ps1 deploy x79
    ./harness.ps1 console verify

.EXAMPLE
    # WSL instead of Git Bash
    $env:HARNESS_WSL = '1'; ./harness.ps1 verify x79

.NOTES
    Exit codes are the script's own: 0 success, 1 failure, 2 usage error or unknown consumer.
    A wrapper that flattened them to 0/1 would hide the difference between "wrong command" and
    "provisioning failed" — the distinction the case-by-case run depends on.
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('deploy', 'provision', 'verify', 'console', 'help')]
    [string] $Command = 'help',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]] $Rest
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$KnownCommands = @{
    deploy    = 'deploy.sh'
    provision = 'provision.sh'
    verify    = 'verify-consumer.sh'
    console   = 'console.sh'
}

function Fail([string] $Message, [int] $Code = 2) {
    Write-Host "x harness.ps1: $Message" -ForegroundColor Red
    exit $Code
}

function Show-Usage {
    @'
Usage: ./harness.ps1 <command> [args...]

  deploy    <consumer|all> [--plan] [--no-build] [--smoke]     -> ./deploy.sh
  provision <consumer|all> [--plan] [--force] [--host-mode m]   -> ./provision.sh
  verify    <consumer|all> [--json] [--strict] [--out <dir>]    -> ./verify-consumer.sh
  console   [up|restart|down|status|health|logs|build|verify]   -> ./console.sh

Bash is found automatically (Git Bash, then WSL). Override:
  $env:HARNESS_BASH = 'C:\Program Files\Git\bin\bash.exe'   # explicit bash
  $env:HARNESS_WSL  = '1'                                    # force WSL

Exit: 0 success · 1 failure · 2 usage error or unknown consumer
'@ | Write-Host
}

<#
    Convert a Windows path to the form the chosen bash understands. Git Bash takes `C:/Users/...`;
    WSL takes `/mnt/c/Users/...`. Getting this wrong is the classic wrapper bug: the script runs, but
    in the wrong directory, against the wrong repo.
#>
function ConvertTo-BashPath([string] $WindowsPath, [bool] $UseWsl) {
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    $slashed = $full -replace '\\', '/'
    if ($UseWsl) {
        if ($slashed -match '^([A-Za-z]):(/.*)$') {
            $drive = $Matches[1].ToLower()
            return "/mnt/$drive$($Matches[2])"
        }
        return $slashed
    }
    return $slashed
}

function Resolve-Bash {
    if ($env:HARNESS_BASH) {
        if (-not (Test-Path -LiteralPath $env:HARNESS_BASH)) {
            Fail "HARNESS_BASH points at '$env:HARNESS_BASH', which does not exist."
        }
        return @{ Path = $env:HARNESS_BASH; Wsl = $false; Wrapper = $null }
    }

    if ($env:HARNESS_WSL -eq '1') {
        if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
            Fail 'HARNESS_WSL=1 but wsl.exe is not on PATH — install WSL or unset HARNESS_WSL.'
        }
        return @{ Path = 'wsl.exe'; Wsl = $true; Wrapper = @('bash') }
    }

    # Git Bash first: it shares PATH and the filesystem view with the Windows shell the operator is
    # already in, so a path printed by the script can be clicked open.
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return @{ Path = $candidate; Wsl = $false; Wrapper = $null }
        }
    }

    $gitBash = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($gitBash) {
        return @{ Path = $gitBash.Source; Wsl = $false; Wrapper = $null }
    }

    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        Write-Host '> Git Bash not found; using WSL bash.' -ForegroundColor Yellow
        Write-Host '  WSL sees a different filesystem: paths, mounts and ~/.harness are its own.' -ForegroundColor Yellow
        return @{ Path = 'wsl.exe'; Wsl = $true; Wrapper = @('bash') }
    }

    Fail @'
no bash found. Install Git for Windows (https://git-scm.com/download/win), enable WSL, or set
  $env:HARNESS_BASH = 'C:\path\to\bash.exe'
The .ps1 is a thin wrapper; the behaviour lives in the .sh scripts and needs a bash to run them.
'@
}

if ($Command -eq 'help') {
    Show-Usage
    exit 0
}

$scriptName = $KnownCommands[$Command]
$scriptPath = Join-Path $RepoRoot $scriptName
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Fail "missing $scriptName in $RepoRoot — is this the harness-eso repo root?" 1
}

$bash = Resolve-Bash
$bashScriptPath = ConvertTo-BashPath $scriptPath $bash.Wsl
$bashRepoRoot = ConvertTo-BashPath $RepoRoot $bash.Wsl

$argv = @()
if ($bash.Wrapper) { $argv += $bash.Wrapper }
# -l so the bash login profile is loaded: on Git Bash that is where `bun` and `node` on PATH come from.
$argv += '-lc'
# One string, not an array: `bash -lc` takes a single command. Quote every forwarded argument so the
# operator's own quoting survives; an argument containing a single quote is escaped POSIX-style.
$quotedArgs = ($Rest | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
$commandLine = "cd '$bashRepoRoot' && exec bash '$bashScriptPath'"

if ($PSBoundParameters.ContainsKey('Rest') -and $Rest.Count -gt 0) {
    $commandLine += " $quotedArgs"
}

Write-Verbose "bash: $($bash.Path)  ->  $commandLine"
& $bash.Path @argv $commandLine
exit $LASTEXITCODE
