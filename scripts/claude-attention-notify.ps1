[CmdletBinding()]
param()

# Claude Code Stop-hook bridge. Claude Code invokes hook commands with the
# event payload on stdin, unlike Codex which passes it as an argument.
# A Stop hook exiting with code 2 blocks Claude from stopping, so this
# script must swallow every error and always exit 0.

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'claude-attention-notify.log'
$pipeRegistryPath = Join-Path $env:TEMP 'agent-attention-pipes'
$extensionAccepted = $false

function Write-AttentionLog {
    param([string] $Message)
    try {
        Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding utf8
    }
    catch {
        # Notification delivery must never fail because logging failed.
    }
}

function Send-AttentionMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string] $PipeName,
        [Parameter(Mandatory = $true)]
        [string] $Message
    )

    $client = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.',
        $PipeName,
        [System.IO.Pipes.PipeDirection]::InOut,
        [System.IO.Pipes.PipeOptions]::Asynchronous
    )
    try {
        $client.Connect(500)
        $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false), 1024, $true)
        $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false), $false, 1024, $true)
        try {
            $writer.AutoFlush = $true
            $writer.WriteLine($Message)
            $responseTask = $reader.ReadLineAsync()
            if ($responseTask.Wait(1250)) {
                return $responseTask.Result -eq 'accepted'
            }
            return $false
        }
        finally {
            $reader.Dispose()
            $writer.Dispose()
        }
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

try {
    $payload = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($payload)) {
        $payload = '{}'
    }
    $parsed = $payload | ConvertFrom-Json -ErrorAction Stop

    $ancestorPids = [System.Collections.Generic.List[int]]::new()
    $currentPid = $PID

    for ($depth = 0; $depth -lt 12 -and $currentPid -gt 0; $depth += 1) {
        if (-not $ancestorPids.Contains($currentPid)) {
            $ancestorPids.Add($currentPid)
        }
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop
        $parentPid = [int] $process.ParentProcessId
        if ($parentPid -le 0 -or $parentPid -eq $currentPid) {
            break
        }
        $currentPid = $parentPid
    }

    $message = [ordered]@{
        source       = 'claude'
        type         = 'turn-ended'
        turnId       = [string] $parsed.session_id
        threadId     = [string] $parsed.session_id
        cwd          = [string] $parsed.cwd
        ancestorPids = $ancestorPids.ToArray()
        timestamp    = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress

    $candidatePipes = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $pipeRegistryPath) {
        foreach ($registrationFile in (Get-ChildItem -LiteralPath $pipeRegistryPath -Filter '*.json' -File | Sort-Object LastWriteTime -Descending)) {
            try {
                $registration = Get-Content -Raw -LiteralPath $registrationFile.FullName | ConvertFrom-Json -ErrorAction Stop
                $registeredPid = [int] $registration.processId
                $registeredPipe = [string] $registration.pipeName
                if ($registeredPid -le 0 -or -not (Get-Process -Id $registeredPid -ErrorAction SilentlyContinue)) {
                    Remove-Item -LiteralPath $registrationFile.FullName -Force -ErrorAction SilentlyContinue
                    continue
                }
                if ($registeredPipe -and -not $candidatePipes.Contains($registeredPipe)) {
                    $candidatePipes.Add($registeredPipe)
                }
            }
            catch {
                Remove-Item -LiteralPath $registrationFile.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if ($env:AGENT_ATTENTION_PIPE -and -not $candidatePipes.Contains($env:AGENT_ATTENTION_PIPE)) {
        $candidatePipes.Add($env:AGENT_ATTENTION_PIPE)
    }

    foreach ($candidatePipe in $candidatePipes) {
        try {
            if (Send-AttentionMessage -PipeName $candidatePipe -Message $message) {
                $extensionAccepted = $true
                break
            }
        }
        catch {
            # A different VS Code window may own this pipe; try the next one.
        }
    }

    if (-not $extensionAccepted) {
        Write-AttentionLog 'No live VS Code attention pipe accepted the Claude turn.'
    }
}
catch {
    Write-AttentionLog "VS Code delivery failed: $($_.Exception.Message)"
}

# Best-effort terminal bell. On Windows, Claude Code spawns hooks into a
# detached invisible console (verified via GetConsoleProcessList: the CLI
# process is not in the hook's console), so this write usually goes nowhere.
# The reliable bell is the CLI ringing its own terminal via the
# preferredNotifChannel = "terminal_bell" setting in ~/.claude.json; the
# injected pane renderer marks the pane from that bell.
try {
    Write-Host -NoNewline ([string][char]7)
}
catch {
    Write-AttentionLog "Terminal bell failed: $($_.Exception.Message)"
}

exit 0
