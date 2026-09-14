[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $NotifyArguments
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP 'codex-attention-notify.log'
$pipeRegistryPath = Join-Path $env:TEMP 'agent-attention-pipes'
$payload = if ($NotifyArguments.Count -gt 0) { $NotifyArguments[-1] } else { '{}' }
$extensionAccepted = $false

# The Codex Windows notifier lives under a per-version runtime hash that
# changes across Codex updates, so discover the newest installed copy.
$existingNotifier = $null
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
if (Test-Path -LiteralPath $runtimeRoot) {
    $existingNotifier = Get-ChildItem -LiteralPath $runtimeRoot -Directory |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object { Join-Path $_.FullName 'bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}

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
        type         = [string] $parsed.type
        turnId       = [string] $parsed.'turn-id'
        threadId     = [string] $parsed.'thread-id'
        cwd          = [string] $parsed.cwd
        ancestorPids = $ancestorPids.ToArray()
        windowsNotifierPath = $existingNotifier
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
        Write-AttentionLog 'No live VS Code attention pipe accepted the turn; Windows notification will fail open.'
    }
}
catch {
    Write-AttentionLog "VS Code delivery failed: $($_.Exception.Message)"
}

try {
    if ($extensionAccepted) {
        # The extension owns delivery and checks the originating terminal's
        # focus directly, without forwarding terminal output.
    }
    elseif ($existingNotifier) {
        & $existingNotifier 'turn-ended' $payload | Out-Null
    }
    else {
        Write-AttentionLog "No installed Codex Windows notifier was found below: $runtimeRoot"
    }
}
catch {
    Write-AttentionLog "Existing Windows notifier failed: $($_.Exception.Message)"
}
