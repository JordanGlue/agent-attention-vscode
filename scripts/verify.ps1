[CmdletBinding()]
param(
    [switch] $CheckInstalled
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
$rendererJs = Join-Path $repoRoot 'renderer\codex-attention-renderer.js'
& node --check $extensionJs
if ($LASTEXITCODE -ne 0) { throw 'extension.js syntax check failed.' }
& node --check $rendererJs
if ($LASTEXITCODE -ne 0) { throw 'renderer JavaScript syntax check failed.' }

foreach ($script in @(
    (Join-Path $PSScriptRoot 'codex-attention-notify.ps1'),
    (Join-Path $PSScriptRoot 'install-codex-attention-renderer.ps1'),
    (Join-Path $PSScriptRoot 'sync-to-profile.ps1'),
    $PSCommandPath
)) {
    [void][scriptblock]::Create((Get-Content -Raw -LiteralPath $script))
}

$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'extension\package.json') | ConvertFrom-Json
if ($manifest.publisher -ne 'jordan' -or $manifest.name -ne 'codex-attention') {
    throw 'Unexpected extension identity in package.json.'
}
if (@($manifest.enabledApiProposals) -notcontains 'terminalDataWriteEvent') {
    throw 'terminalDataWriteEvent is missing from enabledApiProposals.'
}

$rendererText = Get-Content -Raw -LiteralPath $rendererJs
$versionMatch = [regex]::Match($rendererText, 'const VERSION = "([^"]+)"')
if (-not $versionMatch.Success) { throw 'Renderer VERSION was not found.' }
$rendererVersion = $versionMatch.Groups[1].Value
$installerText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'install-codex-attention-renderer.ps1')
if (-not $installerText.Contains("codex-attention-renderer.js?v=$rendererVersion") -or
    -not $installerText.Contains("codex-attention-renderer.css?v=$rendererVersion")) {
    throw "Installer cache-buster does not match renderer version $rendererVersion."
}

$rendererCss = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'renderer\codex-attention-renderer.css')
if (-not $rendererCss.Contains('.editor-instance') -or -not $rendererCss.Contains('.terminal-split-pane')) {
    throw 'Renderer CSS does not cover both supported pane layouts.'
}

if ($CheckInstalled) {
    $extensionTarget = Join-Path $HOME '.vscode\extensions\jordan.codex-attention-0.1.0'
    $codexBin = Join-Path $HOME '.codex\bin'
    Assert-EqualFile $extensionJs (Join-Path $extensionTarget 'extension.js')
    Assert-EqualFile (Join-Path $repoRoot 'extension\package.json') (Join-Path $extensionTarget 'package.json')
    Assert-EqualFile $rendererJs (Join-Path $codexBin 'codex-attention-renderer.js')
    Assert-EqualFile (Join-Path $repoRoot 'renderer\codex-attention-renderer.css') (Join-Path $codexBin 'codex-attention-renderer.css')
    Assert-EqualFile (Join-Path $PSScriptRoot 'codex-attention-notify.ps1') (Join-Path $codexBin 'codex-attention-notify.ps1')
    Assert-EqualFile (Join-Path $PSScriptRoot 'install-codex-attention-renderer.ps1') (Join-Path $codexBin 'install-codex-attention-renderer.ps1')
}

Write-Host "PASS: Codex Attention sources are valid (renderer $rendererVersion)."
