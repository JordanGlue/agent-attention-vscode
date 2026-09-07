[CmdletBinding()]
param(
    [switch] $CheckInstalled,
    # Optional exact resources/app directory; otherwise use the newest build,
    # matching install-agent-attention-renderer.ps1.
    [string] $AppRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

function Assert-EqualFile {
    param([string] $Expected, [string] $Actual)
    if (-not (Test-Path -LiteralPath $Actual)) {
        throw "Installed file is missing: $Actual"
    }
    $expectedText = (Get-Content -Raw -LiteralPath $Expected).Replace("`r`n", "`n")
    $actualText = (Get-Content -Raw -LiteralPath $Actual).Replace("`r`n", "`n")
    if ($expectedText -ne $actualText) {
        throw "Installed file differs from source: $Actual"
    }
}

$extensionJs = Join-Path $repoRoot 'extension\extension.js'
$rendererJs = Join-Path $repoRoot 'renderer\agent-attention-renderer.js'
& node --check $extensionJs
if ($LASTEXITCODE -ne 0) { throw 'extension.js syntax check failed.' }
& node --check $rendererJs
if ($LASTEXITCODE -ne 0) { throw 'renderer JavaScript syntax check failed.' }
& node --test (Join-Path $repoRoot 'tests\workbench-health.test.js')
if ($LASTEXITCODE -ne 0) { throw 'Workbench health regression tests failed.' }

foreach ($script in @(
    (Join-Path $PSScriptRoot 'codex-attention-notify.ps1'),
    (Join-Path $PSScriptRoot 'claude-attention-notify.ps1'),
    (Join-Path $PSScriptRoot 'install-agent-attention-renderer.ps1'),
    (Join-Path $PSScriptRoot 'sync-to-profile.ps1'),
    $PSCommandPath
)) {
    [void][scriptblock]::Create((Get-Content -Raw -LiteralPath $script))
}

$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'extension\package.json') | ConvertFrom-Json
if ($manifest.publisher -ne 'local' -or $manifest.name -ne 'agent-attention') {
    throw 'Unexpected extension identity in package.json.'
}
if (@($manifest.enabledApiProposals) -notcontains 'terminalDataWriteEvent') {
    throw 'terminalDataWriteEvent is missing from enabledApiProposals.'
}

$rendererText = Get-Content -Raw -LiteralPath $rendererJs
$versionMatch = [regex]::Match($rendererText, 'const VERSION = "([^"]+)"')
if (-not $versionMatch.Success) { throw 'Renderer VERSION was not found.' }
$rendererVersion = $versionMatch.Groups[1].Value
$installerText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'install-agent-attention-renderer.ps1')
if (-not $installerText.Contains("agent-attention-renderer.js?v=$rendererVersion") -or
    -not $installerText.Contains("agent-attention-renderer.css?v=$rendererVersion")) {
    throw "Installer cache-buster does not match renderer version $rendererVersion."
}

$rendererCss = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'renderer\agent-attention-renderer.css')
if (-not $rendererCss.Contains('.editor-instance') -or -not $rendererCss.Contains('.terminal-split-pane')) {
    throw 'Renderer CSS does not cover both supported pane layouts.'
}

if ($CheckInstalled) {
    $extensionTarget = Join-Path $HOME '.vscode\extensions\local.agent-attention-0.2.0'
    $agentHome = Join-Path $HOME '.agent-attention'
    Assert-EqualFile $extensionJs (Join-Path $extensionTarget 'extension.js')
    Assert-EqualFile (Join-Path $repoRoot 'extension\workbench-health.js') (Join-Path $extensionTarget 'workbench-health.js')
    Assert-EqualFile (Join-Path $repoRoot 'extension\package.json') (Join-Path $extensionTarget 'package.json')
    Assert-EqualFile $rendererJs (Join-Path $agentHome 'agent-attention-renderer.js')
    Assert-EqualFile (Join-Path $repoRoot 'renderer\agent-attention-renderer.css') (Join-Path $agentHome 'agent-attention-renderer.css')
    Assert-EqualFile (Join-Path $PSScriptRoot 'install-agent-attention-renderer.ps1') (Join-Path $agentHome 'install-agent-attention-renderer.ps1')
    Assert-EqualFile (Join-Path $PSScriptRoot 'codex-attention-notify.ps1') (Join-Path $HOME '.codex\bin\codex-attention-notify.ps1')
    Assert-EqualFile (Join-Path $PSScriptRoot 'claude-attention-notify.ps1') (Join-Path $HOME '.claude\bin\claude-attention-notify.ps1')

    if (-not $AppRoot) {
        $codeRoot = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'
        $build = Get-ChildItem -LiteralPath $codeRoot -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'resources\app\out\vs\code\electron-browser\workbench\workbench.html') } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $AppRoot = if ($build) { Join-Path $build.FullName 'resources\app' } else { Join-Path $codeRoot 'resources\app' }
    }
    & node (Join-Path $repoRoot 'extension\workbench-health.js') $AppRoot
    if ($LASTEXITCODE -ne 0) {
        throw 'Installed VS Code workbench patch is missing or stale. Run scripts\sync-to-profile.ps1, then Developer: Reload Window.'
    }
    $workbench = Join-Path $AppRoot 'out\vs\code\electron-browser\workbench'
    Assert-EqualFile $rendererJs (Join-Path $workbench 'agent-attention-renderer.js')
    Assert-EqualFile (Join-Path $repoRoot 'renderer\agent-attention-renderer.css') (Join-Path $workbench 'agent-attention-renderer.css')
    Write-Host "Verified workbench: $AppRoot"
}

Write-Host "PASS: Agent Attention sources are valid (renderer $rendererVersion)."
