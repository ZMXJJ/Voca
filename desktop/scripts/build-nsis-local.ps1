#requires -Version 5.1
<#
.SYNOPSIS
    Build and sign the Windows NSIS installer for Voca locally.

.DESCRIPTION
    This script mirrors `build-dmg-appleid-local.sh`:
      1. Loads signing credentials from `.env.windows-sign.local` (optional).
      2. Runs `npm run prepare:windows` to stage the CPU-only Python runtime.
      3. Runs `npm run tauri -- build --bundles nsis` to produce the installer.
      4. Signs both the embedded Voca.exe and the NSIS setup executable with
         `signtool`, using SHA-256 with an RFC 3161 timestamp.

    If signing credentials are missing the script still builds but skips
    signing (useful for smoke-testing the pipeline).

.ENVIRONMENT
    Read from .env.windows-sign.local (simple KEY=VALUE lines):
      SIGNTOOL_CERT_PATH       Absolute path to the .pfx certificate.
      SIGNTOOL_CERT_PASSWORD   Password for the certificate.
      SIGNTOOL_TIMESTAMP_URL   RFC3161 timestamp URL (e.g. http://timestamp.digicert.com).
      SIGNTOOL_PATH            Optional override for signtool.exe location.
#>

[CmdletBinding()]
param(
    [switch]$SkipSign
)

$ErrorActionPreference = "Stop"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Resolve-Path (Join-Path $scriptDir "..")
$envFile    = Join-Path $desktopDir ".env.windows-sign.local"

function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Host "[build-nsis] $Path not found; continuing without signing env"
        return
    }

    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -notmatch "^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$") { return }
        $name  = $Matches["name"]
        $value = $Matches["value"]
        if ($value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

function Resolve-SignTool {
    if ($env:SIGNTOOL_PATH -and (Test-Path $env:SIGNTOOL_PATH)) {
        return $env:SIGNTOOL_PATH
    }
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
        "C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe"
    )
    foreach ($pattern in $candidates) {
        $match = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($match) { return $match.FullName }
    }
    throw "signtool.exe not found. Install the Windows 10/11 SDK or set SIGNTOOL_PATH."
}

function Invoke-Signing {
    param(
        [string]$SignTool,
        [string]$Target,
        [string]$Cert,
        [string]$Password,
        [string]$TimestampUrl
    )

    Write-Host "[build-nsis] signing $Target"
    & $SignTool sign `
        /fd sha256 `
        /tr $TimestampUrl `
        /td sha256 `
        /f  $Cert `
        /p  $Password `
        $Target
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed for $Target (exit $LASTEXITCODE)"
    }
}

Import-EnvFile -Path $envFile

Push-Location $desktopDir
try {
    Write-Host "[build-nsis] npm run prepare:windows"
    npm run prepare:windows
    if ($LASTEXITCODE -ne 0) { throw "prepare:windows failed" }

    Write-Host "[build-nsis] npm run tauri -- build --bundles nsis"
    npm run tauri -- build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
    Pop-Location
}

$releaseRoot      = Join-Path $desktopDir "src-tauri\target\release"
$embeddedExePath  = Join-Path $releaseRoot "Voca.exe"
$nsisBundleRoot   = Join-Path $releaseRoot "bundle\nsis"
$installerPattern = "Voca_*_x64-setup.exe"

$installer = Get-ChildItem -Path $nsisBundleRoot -Filter $installerPattern -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $installer) {
    throw "No NSIS installer produced under $nsisBundleRoot"
}

Write-Host "[build-nsis] installer: $($installer.FullName)"

$cert         = $env:SIGNTOOL_CERT_PATH
$password     = $env:SIGNTOOL_CERT_PASSWORD
$timestampUrl = if ($env:SIGNTOOL_TIMESTAMP_URL) { $env:SIGNTOOL_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }

if ($SkipSign -or -not $cert -or -not $password) {
    Write-Warning "[build-nsis] Skipping code signing (SkipSign=$SkipSign, credentials missing=$($cert -eq $null -or $password -eq $null))"
    Write-Host "[build-nsis] installer is available at $($installer.FullName)"
    exit 0
}

if (-not (Test-Path $cert)) {
    throw "Certificate not found: $cert"
}

$signTool = Resolve-SignTool
Write-Host "[build-nsis] signtool: $signTool"

# Sign the embedded Voca.exe first so Tauri reuses the signed binary on the next rebuild.
if (Test-Path $embeddedExePath) {
    Invoke-Signing -SignTool $signTool -Target $embeddedExePath -Cert $cert -Password $password -TimestampUrl $timestampUrl
}

Invoke-Signing -SignTool $signTool -Target $installer.FullName -Cert $cert -Password $password -TimestampUrl $timestampUrl

Write-Host "[build-nsis] done. Signed installer: $($installer.FullName)"
