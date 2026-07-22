[CmdletBinding()]
param(
    [switch] $SkipWorkbenchPatch
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$extensionSource = Join-Path $repoRoot 'extension'
$rendererSource = Join-Path $repoRoot 'renderer'
$extensionTarget = Join-Path $HOME '.vscode\extensions\local.agent-attention-0.2.0'
$agentHome = Join-Path $HOME '.agent-attention'
$codexBin = Join-Path $HOME '.codex\bin'
$claudeBin = Join-Path $HOME '.claude\bin'
$maintenanceTarget = Join-Path $agentHome 'MAINTENANCE.md'

New-Item -ItemType Directory -Force -Path $extensionTarget, $agentHome, $codexBin, $claudeBin | Out-Null

foreach ($name in 'extension.js', 'package.json', 'README.md') {
    Copy-Item -LiteralPath (Join-Path $extensionSource $name) -Destination (Join-Path $extensionTarget $name) -Force
}

foreach ($name in 'agent-attention-renderer.js', 'agent-attention-renderer.css') {
    Copy-Item -LiteralPath (Join-Path $rendererSource $name) -Destination (Join-Path $agentHome $name) -Force
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-agent-attention-renderer.ps1') -Destination (Join-Path $agentHome 'install-agent-attention-renderer.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'codex-attention-notify.ps1') -Destination (Join-Path $codexBin 'codex-attention-notify.ps1') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'claude-attention-notify.ps1') -Destination (Join-Path $claudeBin 'claude-attention-notify.ps1') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\MAINTENANCE.md') -Destination $maintenanceTarget -Force

# Remove artifacts deployed under the project's pre-rename identity.
$legacyPaths = @(
    (Join-Path $HOME '.vscode\extensions\jordan.codex-attention-0.1.0'),
    (Join-Path $codexBin 'codex-attention-renderer.js'),
    (Join-Path $codexBin 'codex-attention-renderer.css'),
    (Join-Path $codexBin 'install-codex-attention-renderer.ps1'),
    (Join-Path $HOME '.codex\CODEX_ATTENTION.md')
)
foreach ($legacyPath in $legacyPaths) {
    if (Test-Path -LiteralPath $legacyPath) {
        Remove-Item -LiteralPath $legacyPath -Recurse -Force
        Write-Host "Removed legacy deployment: $legacyPath"
    }
}

# argv.json is JSONC (comments allowed), so match on text instead of parsing.
# VS Code reads it from ~/.vscode/argv.json; older setups used %APPDATA%\Code.
$argvCandidates = @(
    (Join-Path $HOME '.vscode\argv.json'),
    (Join-Path $env:APPDATA 'Code\argv.json')
)
$argvEnabled = $false
foreach ($argvPath in $argvCandidates) {
    if ((Test-Path -LiteralPath $argvPath) -and
        (Get-Content -Raw -LiteralPath $argvPath).Contains('local.agent-attention')) {
        $argvEnabled = $true
        break
    }
}
if (-not $argvEnabled) {
    Write-Warning 'No argv.json enables proposed APIs for local.agent-attention.'
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
    & (Join-Path $agentHome 'install-agent-attention-renderer.ps1')
}

Write-Host 'Profile deployment complete.'
Write-Host 'Run "Developer: Reload Window" in VS Code to load all changes.'
