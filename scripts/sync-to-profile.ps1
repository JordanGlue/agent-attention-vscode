[CmdletBinding()]
param(
    [switch] $SkipWorkbenchPatch
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$extensionSource = Join-Path $repoRoot 'extension'
$rendererSource = Join-Path $repoRoot 'renderer'
$extensionTarget = Join-Path $HOME '.vscode\extensions\jordan.codex-attention-0.1.0'
$codexBin = Join-Path $HOME '.codex\bin'
$maintenanceTarget = Join-Path $HOME '.codex\CODEX_ATTENTION.md'

New-Item -ItemType Directory -Force -Path $extensionTarget, $codexBin | Out-Null

foreach ($name in 'extension.js', 'package.json', 'README.md') {
    Copy-Item -LiteralPath (Join-Path $extensionSource $name) -Destination (Join-Path $extensionTarget $name) -Force
}

foreach ($name in 'codex-attention-renderer.js', 'codex-attention-renderer.css') {
    Copy-Item -LiteralPath (Join-Path $rendererSource $name) -Destination (Join-Path $codexBin $name) -Force
}

foreach ($name in 'codex-attention-notify.ps1', 'install-codex-attention-renderer.ps1') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $codexBin $name) -Force
}

Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\MAINTENANCE.md') -Destination $maintenanceTarget -Force

$argvPath = Join-Path $env:APPDATA 'Code\argv.json'
if (Test-Path -LiteralPath $argvPath) {
    $argv = Get-Content -Raw -LiteralPath $argvPath | ConvertFrom-Json
    if (@($argv.'enable-proposed-api') -notcontains 'jordan.codex-attention') {
        Write-Warning "$argvPath does not enable proposed APIs for jordan.codex-attention."
    }
} else {
    Write-Warning "$argvPath is missing."
}

$configPath = Join-Path $HOME '.codex\config.toml'
if (-not (Test-Path -LiteralPath $configPath) -or
    -not (Get-Content -Raw -LiteralPath $configPath).Contains('codex-attention-notify.ps1')) {
    Write-Warning 'Codex config.toml does not appear to point notify at codex-attention-notify.ps1.'
}

if (-not $SkipWorkbenchPatch) {
    & (Join-Path $codexBin 'install-codex-attention-renderer.ps1')
}

Write-Host 'Profile deployment complete.'
Write-Host 'Run "Developer: Reload Window" in VS Code to load all changes.'
