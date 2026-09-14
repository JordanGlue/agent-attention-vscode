[CmdletBinding()]
param(
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'

$codeRoot = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code'
$relativeWorkbench = 'resources\app\out\vs\code\electron-browser\workbench'
$build = Get-ChildItem -LiteralPath $codeRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "$relativeWorkbench\workbench.html") } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

# A standard VS Code user install is flat: workbench.html sits directly below
# $codeRoot rather than in a per-build subdirectory. In-place updates reuse
# that path, so backups for the flat layout are keyed by the app version.
if ($build) {
    $buildLabel = $build.Name
} elseif (Test-Path -LiteralPath (Join-Path $codeRoot "$relativeWorkbench\workbench.html")) {
    $build = Get-Item -LiteralPath $codeRoot
    $appVersion = (Get-Content -Raw -LiteralPath (Join-Path $codeRoot 'resources\app\package.json') | ConvertFrom-Json).version
    $buildLabel = "code-$appVersion"
}

if (-not $build) {
    throw "Could not find an installed VS Code workbench below $codeRoot"
}

$workbenchDir = Join-Path $build.FullName $relativeWorkbench
$htmlPath = Join-Path $workbenchDir 'workbench.html'
$productPath = Join-Path $build.FullName 'resources\app\product.json'
$cssTarget = Join-Path $workbenchDir 'agent-attention-renderer.css'
$jsTarget = Join-Path $workbenchDir 'agent-attention-renderer.js'
$legacyCssTarget = Join-Path $workbenchDir 'codex-attention-renderer.css'
$legacyJsTarget = Join-Path $workbenchDir 'codex-attention-renderer.js'
$cssSource = Join-Path $PSScriptRoot 'agent-attention-renderer.css'
$jsSource = Join-Path $PSScriptRoot 'agent-attention-renderer.js'
$cssTag = "`t`t<link rel=`"stylesheet`" href=`"./agent-attention-renderer.css?v=0.6.0`">"
$jsTag = "`t<script src=`"./agent-attention-renderer.js?v=0.6.0`" type=`"module`"></script>"
$html = Get-Content -Raw -LiteralPath $htmlPath

function Remove-AttentionTags {
    param([string] $Html)
    # Also matches the pre-rename codex-attention asset names so upgrading
    # a previously patched build replaces the old tags instead of stacking.
    $result = [regex]::Replace($Html, '[ \t]*<link rel="stylesheet" href="\./(?:codex|agent)-attention-renderer\.css\?v=[^"]*">\r?\n', '')
    return [regex]::Replace($result, '[ \t]*<script src="\./(?:codex|agent)-attention-renderer\.js\?v=[^"]*" type="module"></script>\r?\n', '')
}

function Remove-AttentionProposalEntries {
    param([string] $Product)
    return [regex]::Replace(
        $Product,
        '\r?\n\t\t"(?:jordan\.codex-attention|local\.agent-attention)": \[\r?\n\t\t\t"terminalDataWriteEvent"\r?\n\t\t\],',
        ''
    )
}

if ($Remove) {
    $updated = Remove-AttentionTags -Html $html
    if ($updated -ne $html) {
        [IO.File]::WriteAllText($htmlPath, $updated, [Text.UTF8Encoding]::new($false))
    }
    $product = Get-Content -Raw -LiteralPath $productPath
    $productUpdated = Remove-AttentionProposalEntries -Product $product
    if ($productUpdated -ne $product) {
        [IO.File]::WriteAllText($productPath, $productUpdated, [Text.UTF8Encoding]::new($false))
    }
    Remove-Item -LiteralPath $cssTarget, $jsTarget, $legacyCssTarget, $legacyJsTarget -Force -ErrorAction SilentlyContinue
    Write-Host "Removed the agent attention pane renderer from VS Code build $buildLabel."
    Write-Host 'Run "Developer: Reload Window" in VS Code to unload it.'
    Write-Host "Guide: $HOME\.agent-attention\MAINTENANCE.md"
    return
}

if (-not (Test-Path -LiteralPath $cssSource) -or -not (Test-Path -LiteralPath $jsSource)) {
    throw "Renderer source files are missing from $PSScriptRoot"
}

$backupDir = Join-Path $HOME ".agent-attention\backups\vscode-renderer\$buildLabel"
$backupPath = Join-Path $backupDir 'workbench.html.original'
$productBackupPath = Join-Path $backupDir 'product.json.original'
if (-not (Test-Path -LiteralPath $backupPath)) {
    if ($html.Contains('agent-attention-renderer') -or $html.Contains('codex-attention-renderer')) {
        throw "This build is already patched, but its pristine backup is missing: $backupPath"
    }
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -LiteralPath $htmlPath -Destination $backupPath
}

$product = Get-Content -Raw -LiteralPath $productPath
if (-not (Test-Path -LiteralPath $productBackupPath)) {
    if ($product.Contains('"local.agent-attention"') -or $product.Contains('"jordan.codex-attention"')) {
        throw "This build's product metadata is already patched, but its pristine backup is missing: $productBackupPath"
    }
    Copy-Item -LiteralPath $productPath -Destination $productBackupPath
}

Copy-Item -LiteralPath $cssSource -Destination $cssTarget -Force
Copy-Item -LiteralPath $jsSource -Destination $jsTarget -Force
Remove-Item -LiteralPath $legacyCssTarget, $legacyJsTarget -Force -ErrorAction SilentlyContinue

$newline = if ($html.Contains("`r`n")) { "`r`n" } else { "`n" }
# Strip any previously injected tags first so a version bump replaces the
# old cache-buster URLs instead of accumulating a second, older tag pair.
$updated = Remove-AttentionTags -Html $html
if (-not $updated.Contains($cssTag)) {
    $mainCssTag = "`t`t<link rel=`"stylesheet`" href=`"../../../workbench/workbench.desktop.main.css`">"
    if (-not $updated.Contains($mainCssTag)) { throw 'VS Code CSS loader anchor changed.' }
    $updated = $updated.Replace($mainCssTag, "$mainCssTag$newline$cssTag")
}
if (-not $updated.Contains($jsTag)) {
    $workbenchTag = "`t<script src=`"./workbench.js`" type=`"module`"></script>"
    if (-not $updated.Contains($workbenchTag)) { throw 'VS Code script loader anchor changed.' }
    $updated = $updated.Replace($workbenchTag, "$workbenchTag$newline$jsTag")
}

if ($updated -ne $html) {
    [IO.File]::WriteAllText($htmlPath, $updated, [Text.UTF8Encoding]::new($false))
}

$productCleaned = Remove-AttentionProposalEntries -Product $product
if ($productCleaned -ne $product) {
    [IO.File]::WriteAllText($productPath, $productCleaned, [Text.UTF8Encoding]::new($false))
}

Write-Host "Installed the agent attention pane renderer into VS Code build $buildLabel."
Write-Host "Backup: $backupPath"
Write-Host "Product backup: $productBackupPath"
Write-Host 'Run "Developer: Reload Window" in VS Code to load it.'
Write-Host "Guide: $HOME\.agent-attention\MAINTENANCE.md"
