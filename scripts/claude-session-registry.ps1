[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Start', 'Stop', 'End')]
    [string] $Event
)

# Claude Code session-registry hook. Keeps one JSON file per interactive
# session under ~/.agent-attention/sessions so the Agent Attention extension
# can restore unfinished sessions after a reboot. Wire it to SessionStart,
# Stop and SessionEnd. Like every hook bridge here it must never fail the
# session: swallow every error and always exit 0.

$ErrorActionPreference = 'Stop'
$registryDir = Join-Path $HOME '.agent-attention\sessions'
$logPath = Join-Path $env:TEMP 'claude-session-registry.log'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$maxMessageChars = 2000
$transcriptTailBytes = 262144
# SessionEnd reasons that mean the user finished with the session. Anything
# else (terminal closed, reboot, /resume into another session) stays open.
$closingReasons = @('prompt_input_exit', 'logout', 'clear')

function Write-RegistryLog {
    param([string] $Message)
    try {
        Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) [$Event] $Message" -Encoding utf8
    }
    catch {
        # Logging must never break the hook.
    }
}

function Get-Field {
    param($Object, [string] $Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function ConvertTo-Hashtable {
    param($Object)
    $table = [ordered]@{}
    if ($null -eq $Object) { return $table }
    foreach ($property in $Object.PSObject.Properties) {
        $table[$property.Name] = $property.Value
    }
    return $table
}

function Get-ClaudeProcessInfo {
    # Walk up from this hook to the claude.exe that spawned it, collecting
    # ancestor PIDs so the extension can match the owning VS Code terminal.
    $ancestors = [System.Collections.Generic.List[int]]::new()
    $claude = $null
    $currentPid = $PID
    for ($depth = 0; $depth -lt 12 -and $currentPid -gt 0; $depth += 1) {
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $currentPid"
        if (-not $process) { break }
        if (-not $ancestors.Contains($currentPid)) { $ancestors.Add($currentPid) }
        if (-not $claude -and $process.Name -match '^claude(\.exe)?$') {
            $claude = $process
        }
        $parentPid = [int] $process.ParentProcessId
        if ($parentPid -le 0 -or $parentPid -eq $currentPid) { break }
        $currentPid = $parentPid
    }
    $headless = $false
    if ($claude -and $claude.CommandLine -match '(^|\s)(-p|--print)(\s|$)') {
        $headless = $true
    }
    return @{
        ClaudePid       = if ($claude) { [int] $claude.ProcessId } else { 0 }
        ClaudeStartedAt = if ($claude) { $claude.CreationDate.ToUniversalTime().ToString('o') } else { $null }
        AncestorPids    = $ancestors.ToArray()
        Headless        = $headless
    }
}

function Get-TranscriptTitle {
    param([string] $TranscriptPath)
    if (-not $TranscriptPath -or -not (Test-Path -LiteralPath $TranscriptPath)) { return $null }
    $stream = [System.IO.File]::Open($TranscriptPath, 'Open', 'Read', 'ReadWrite')
    try {
        $offset = [Math]::Max(0, $stream.Length - $transcriptTailBytes)
        [void] $stream.Seek($offset, 'Begin')
        $reader = [System.IO.StreamReader]::new($stream, $utf8)
        $tail = $reader.ReadToEnd()
    }
    finally {
        $stream.Dispose()
    }
    # A title set with /rename or --name wins over the generated one.
    foreach ($field in 'customTitle', 'aiTitle') {
        $found = [regex]::Matches($tail, '"' + $field + '":"((?:[^"\\]|\\.)*)"')
        if ($found.Count -gt 0) {
            return ('"' + $found[$found.Count - 1].Groups[1].Value + '"') | ConvertFrom-Json
        }
    }
    return $null
}

function Save-Record {
    param([string] $Path, $Record)
    $json = $Record | ConvertTo-Json -Depth 6
    $temp = "$Path.$PID.tmp"
    [System.IO.File]::WriteAllText($temp, $json, $utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

try {
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $payloadText = $reader.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($payloadText)) { exit 0 }
    $payload = $payloadText | ConvertFrom-Json

    $sessionId = [string] (Get-Field $payload 'session_id')
    if ($sessionId -notmatch '^[A-Za-z0-9-]+$') { exit 0 }

    New-Item -ItemType Directory -Force -Path $registryDir | Out-Null
    $recordPath = Join-Path $registryDir "$sessionId.json"
    $now = (Get-Date).ToUniversalTime().ToString('o')

    $record = [ordered]@{}
    if (Test-Path -LiteralPath $recordPath) {
        $existing = Get-Content -Raw -LiteralPath $recordPath -Encoding utf8 | ConvertFrom-Json
        $record = ConvertTo-Hashtable $existing
        if ($record['headless']) { exit 0 }
    }

    $isNew = -not $record.Contains('sessionId')
    $source = [string] (Get-Field $payload 'source')
    # Refresh process details when a process (re)attaches: first sight of the
    # session, or a new process picking up an existing session id.
    if ($isNew -or ($Event -eq 'Start' -and $source -in @('startup', 'resume', 'fork'))) {
        $info = Get-ClaudeProcessInfo
        if ($info.Headless) {
            if (-not $isNew) { exit 0 }
            Save-Record $recordPath ([ordered]@{ sessionId = $sessionId; headless = $true; updatedAt = $now })
            exit 0
        }
        $record['claudePid'] = $info.ClaudePid
        $record['claudeStartedAt'] = $info.ClaudeStartedAt
        $record['ancestorPids'] = $info.AncestorPids
    }

    if ($isNew) {
        $record['sessionId'] = $sessionId
        $record['startedAt'] = $now
        $record['cards'] = [ordered]@{}
    }
    $record['cwd'] = [string] (Get-Field $payload 'cwd')
    $record['transcriptPath'] = [string] (Get-Field $payload 'transcript_path')
    $permissionMode = [string] (Get-Field $payload 'permission_mode')
    if ($permissionMode) { $record['permissionMode'] = $permissionMode }
    $record['updatedAt'] = $now

    $sessionTitle = $null
    switch ($Event) {
        'Start' {
            $record['status'] = 'open'
            $record['endReason'] = $null
            $hookTitle = [string] (Get-Field $payload 'session_title')
            if ($hookTitle) {
                $record['title'] = $hookTitle
            }
            elseif ($source -eq 'resume' -and $record['card']) {
                # No explicit name yet: lead the title with the tracked card
                # so the /resume picker and agent view are searchable by it.
                $base = if ($record['title']) { [string] $record['title'] } else { 'resumed session' }
                if (-not $base.StartsWith([string] $record['card'])) {
                    $sessionTitle = "$($record['card']) - $base"
                    $record['title'] = $sessionTitle
                }
            }
        }
        'Stop' {
            $record['status'] = 'open'
            $message = [string] (Get-Field $payload 'last_assistant_message')
            if ($message) {
                if ($message.Length -gt $maxMessageChars) {
                    $message = $message.Substring($message.Length - $maxMessageChars)
                }
                $record['lastMessage'] = $message
                $cards = ConvertTo-Hashtable $record['cards']
                foreach ($match in [regex]::Matches($message, '\bTRYB-\d{3,6}\b')) {
                    $card = $match.Value.ToUpperInvariant()
                    $cards[$card] = [int] $cards[$card] + 1
                }
                $record['cards'] = $cards
                if ($cards.Count -gt 0) {
                    $record['card'] = ($cards.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
                }
            }
            $title = Get-TranscriptTitle $record['transcriptPath']
            if ($title) { $record['title'] = $title }
        }
        'End' {
            $reason = [string] (Get-Field $payload 'reason')
            $record['endReason'] = $reason
            $record['status'] = if ($reason -in $closingReasons) { 'closed' } else { 'open' }
            $record['endedAt'] = $now
        }
    }

    Save-Record $recordPath $record

    if ($sessionTitle) {
        [Console]::OutputEncoding = $utf8
        $output = @{ hookSpecificOutput = @{ hookEventName = 'SessionStart'; sessionTitle = $sessionTitle } }
        [Console]::Out.Write(($output | ConvertTo-Json -Compress -Depth 4))
    }
}
catch {
    Write-RegistryLog "Registry update failed: $($_.Exception.Message)"
}

exit 0
