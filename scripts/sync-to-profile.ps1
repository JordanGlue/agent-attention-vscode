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
$claudeBin = Join-Path $HOME '.claude\bin'
$maintenanceTarget = Join-Path $HOME '.codex\CODEX_ATTENTION.md'

New-Item -ItemType Directory -Force -Path $extensionTarget, $codexBin, $claudeBin | Out-Null

foreach ($name in 'extension.js', 'package.json', 'README.md') {
    Copy-Item -LiteralPath (Join-Path $extensionSource $name) -Destination (Join-Path $extensionTarget $name) -Force
}

foreach ($name in 'codex-attention-renderer.js', 'codex-attention-renderer.css') {
    Copy-Item -LiteralPath (Join-Path $rendererSource $name) -Destination (Join-Path $codexBin $name) -Force
}

foreach ($name in 'codex-attention-notify.ps1', 'install-codex-attention-renderer.ps1') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $codexBin $name) -Force
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'claude-attention-notify.ps1') -Destination (Join-Path $claudeBin 'claude-attention-notify.ps1') -Force

Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\MAINTENANCE.md') -Destination $maintenanceTarget -Force

# argv.json is JSONC (comments allowed), so match on text instead of parsing.
# VS Code reads it from ~/.vscode/argv.json; older setups used %APPDATA%\Code.
$argvCandidates = @(
    (Join-Path $HOME '.vscode\argv.json'),
    (Join-Path $env:APPDATA 'Code\argv.json')
)
$argvEnabled = $false
foreach ($argvPath in $argvCandidates) {
    if ((Test-Path -LiteralPath $argvPath) -and
        (Get-Content -Raw -LiteralPath $argvPath).Contains('jordan.codex-attention')) {
        $argvEnabled = $true
        break
    }
}
if (-not $argvEnabled) {
    Write-Warning 'No argv.json enables proposed APIs for jordan.codex-attention.'
}

$configPath = Join-Path $HOME '.codex\config.toml'
if (-not (Test-Path -LiteralPath $configPath) -or
    -not (Get-Content -Raw -LiteralPath $configPath).Contains('codex-attention-notify.ps1')) {
    Write-Warning 'Codex config.toml does not appear to point notify at codex-attention-notify.ps1.'
}

$claudeSettingsPath = Join-Path $HOME '.claude\settings.json'
if (-not (Test-Path -LiteralPath $claudeSettingsPath) -or
    -not (Get-Content -Raw -LiteralPath $claudeSettingsPath).Contains('claude-attention-notify.ps1')) {
    Write-Warning 'Claude settings.json does not wire a Stop hook to claude-attention-notify.ps1.'
}

if (-not $SkipWorkbenchPatch) {
    & (Join-Path $codexBin 'install-codex-attention-renderer.ps1')
}

Write-Host 'Profile deployment complete.'
Write-Host 'Run "Developer: Reload Window" in VS Code to load all changes.'
