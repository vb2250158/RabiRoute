param(
    [int]$PortA = 0,
    [int]$PortB = 0
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rabiroute-relay-shared-state-" + [System.Guid]::NewGuid().ToString("N"))
$token = "app-token-shared-state"
$accountId = "account-smoke"
$appId = "app-smoke"
$deviceId = "pc-a"
$deviceGuid = "guid-pc-a"
$serverA = $null
$serverB = $null
$previousRelayDataDir = $env:RABILINK_RELAY_DATA_DIR
$previousRelayHost = $env:RABILINK_RELAY_HOST
$previousRelayPort = $env:RABILINK_RELAY_PORT

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return $listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Join-Url {
    param(
        [string]$Base,
        [string]$Path
    )

    return $Base.TrimEnd("/") + "/" + $Path.TrimStart("/")
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Write-Step {
    param(
        [string]$Name,
        [string]$Detail = ""
    )

    if ($Detail) {
        Write-Host "[ok] $Name - $Detail" -ForegroundColor Green
    } else {
        Write-Host "[ok] $Name" -ForegroundColor Green
    }
}

function Wait-Health {
    param(
        [string]$BaseUrl,
        [string[]]$LogPaths = @()
    )

    $deadline = (Get-Date).AddSeconds(20)
    do {
        try {
            $health = Invoke-RestMethod -Method Get -Uri (Join-Url $BaseUrl "/health") -TimeoutSec 2
            if ($health.ok -eq $true) {
                return
            }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    } while ((Get-Date) -lt $deadline)

    foreach ($logPath in $LogPaths) {
        if (Test-Path -LiteralPath $logPath) {
            Write-Host "[log] $logPath" -ForegroundColor Yellow
            Get-Content -LiteralPath $logPath -Tail 40
        }
    }
    throw "Relay server did not become healthy: $BaseUrl"
}

function Start-Relay {
    param(
        [int]$Port,
        [string]$DataPath,
        [string]$StdoutPath,
        [string]$StderrPath
    )

    $env:RABILINK_RELAY_DATA_DIR = $DataPath
    $env:RABILINK_RELAY_HOST = "127.0.0.1"
    $env:RABILINK_RELAY_PORT = [string]$Port
    return Start-Process -FilePath "node" -ArgumentList @("scripts/rabilink-relay-server.mjs") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
}

try {
    if ($PortA -le 0) {
        $PortA = Get-FreeTcpPort
    }
    if ($PortB -le 0) {
        do {
            $PortB = Get-FreeTcpPort
        } while ($PortB -eq $PortA)
    }
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $now = (Get-Date).ToUniversalTime().ToString("o")
    @{
        accounts = @(
            @{
                id = $accountId
                username = "smoke"
                passwordHash = ""
                passwordSalt = ""
                createdAt = $now
                updatedAt = $now
            }
        )
        apps = @(
            @{
                id = $appId
                name = "Rokid Glass"
                ownerAccountId = $accountId
                enabled = $true
                token = $token
                tokenPreview = "app-...state"
                targetDeviceId = $deviceId
                createdAt = $now
                updatedAt = $now
            }
        )
        workers = @(
            @{
                id = $deviceId
                guid = $deviceGuid
                name = "Shared State PC"
                appId = $appId
                firstSeenAt = $now
                lastSeenAt = $now
            }
        )
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $dataDir "apps.json") -Encoding UTF8

    $stdoutA = Join-Path $dataDir "relay-a.stdout.log"
    $stderrA = Join-Path $dataDir "relay-a.stderr.log"
    $stdoutB = Join-Path $dataDir "relay-b.stdout.log"
    $stderrB = Join-Path $dataDir "relay-b.stderr.log"
    $serverA = Start-Relay -Port $PortA -DataPath $dataDir -StdoutPath $stdoutA -StderrPath $stderrA
    $serverB = Start-Relay -Port $PortB -DataPath $dataDir -StdoutPath $stdoutB -StderrPath $stderrB
    $baseA = "http://127.0.0.1:${PortA}"
    $baseB = "http://127.0.0.1:${PortB}"
    Wait-Health $baseA @($stdoutA, $stderrA)
    Wait-Health $baseB @($stdoutB, $stderrB)
    Write-Step "servers healthy" "$baseA and $baseB"

    $authHeaders = @{
        "X-RabiLink-Token" = $token
    }
    $jsonHeaders = @{
        "X-RabiLink-Token" = $token
        "Content-Type" = "application/json"
    }

    $submitBody = @{
        text = "shared state smoke"
        sender = "rabilink-shared-state-smoke"
        context = "submit on relay A"
    } | ConvertTo-Json -Compress
    $submit = Invoke-RestMethod -Method Post -Uri (Join-Url $baseA "/rokid/rabilink/tasks") -Headers $jsonHeaders -Body $submitBody -TimeoutSec 10
    Assert-True ($submit.ok -eq $true) "Task submit on relay A did not return ok=true."
    $taskId = [string]$submit.taskId
    Assert-True ([bool]$taskId) "Task submit on relay A did not return taskId."
    $globalAfter = [string]$submit.nextCursor
    Write-Step "submit on A" $taskId

    $claimPath = "/worker/tasks?limit=1&deviceId=$([uri]::EscapeDataString($deviceId))&deviceGuid=$([uri]::EscapeDataString($deviceGuid))&waitMs=2000"
    $claimed = Invoke-RestMethod -Method Get -Uri (Join-Url $baseB $claimPath) -Headers $authHeaders -TimeoutSec 10
    Assert-True ($claimed.ok -eq $true) "Worker claim on relay B did not return ok=true."
    Assert-True (@($claimed.tasks).Count -eq 1) "Worker claim on relay B did not return one task."
    Assert-True ([string]$claimed.tasks[0].id -eq $taskId) "Worker claim on relay B returned a different task."
    Write-Step "claim on B" $taskId

    $finishBody = @{
        text = "shared state reply ok"
        ok = $true
        deviceId = $deviceId
        deviceGuid = $deviceGuid
    } | ConvertTo-Json -Compress
    $finish = Invoke-RestMethod -Method Post -Uri (Join-Url $baseB "/worker/tasks/$taskId/finish") -Headers $jsonHeaders -Body $finishBody -TimeoutSec 10
    Assert-True ($finish.ok -eq $true) "Worker finish on relay B did not return ok=true."
    Write-Step "finish on B" $taskId

    $messagesUrl = Join-Url $baseA ("/rokid/rabilink/messages?after={0}&waitMs=2000" -f [uri]::EscapeDataString($globalAfter))
    $outbox = Invoke-RestMethod -Method Get -Uri $messagesUrl -Headers $authHeaders -TimeoutSec 10
    Assert-True ($outbox.ok -eq $true) "getRabiLinkMessages on relay A did not return ok=true."
    Assert-True ($outbox.status -eq "messages") "getRabiLinkMessages on relay A did not return status=messages."
    Assert-True (@($outbox.messages).Count -ge 1) "getRabiLinkMessages on relay A did not return shared-state message."
    Assert-True (($outbox.messages | ConvertTo-Json -Depth 8) -like "*$taskId*") "Outbox message did not include the submitted taskId."
    Assert-True (($outbox.text -like "*shared state reply ok*") -or (($outbox.messages | ConvertTo-Json -Depth 8) -like "*shared state reply ok*")) "Outbox did not contain worker reply."
    Assert-True (Test-Path -LiteralPath (Join-Path $dataDir "runtime-state.json")) "runtime-state.json was not written."
    Write-Step "getRabiLinkMessages on A" ("messages={0}, nextCursor={1}" -f @($outbox.messages).Count, $outbox.nextCursor)

    $proactiveBody = @{
        text = "shared proactive message"
        source = "shared-state-smoke"
    } | ConvertTo-Json -Compress
    $proactive = Invoke-RestMethod -Method Post -Uri (Join-Url $baseB "/worker/messages") -Headers $jsonHeaders -Body $proactiveBody -TimeoutSec 10
    Assert-True ($proactive.ok -eq $true) "Proactive append on relay B did not return ok=true."
    $proactiveUrl = Join-Url $baseA ("/rokid/rabilink/messages?stream=1&after={0}&waitMs=2000" -f [uri]::EscapeDataString([string]$outbox.nextCursor))
    $proactiveOutbox = Invoke-RestMethod -Method Get -Uri $proactiveUrl -Headers $authHeaders -TimeoutSec 10
    Assert-True ($proactiveOutbox.ok -eq $true) "Continuous stream on relay A did not return ok=true."
    Assert-True ($proactiveOutbox.shouldContinue -eq $true) "Continuous stream should remain open after proactive delivery."
    Assert-True (@($proactiveOutbox.messages).Count -eq 1) "Continuous stream did not return exactly one proactive message."
    Assert-True ($proactiveOutbox.messages[0].proactive -eq $true) "Shared proactive message was not marked proactive."
    Assert-True (-not [bool]$proactiveOutbox.messages[0].taskId) "Shared proactive message must not require a taskId."
    Assert-True ([string]$proactiveOutbox.messages[0].text -eq "shared proactive message") "Shared proactive message text changed."
    Write-Step "proactive on B, stream on A" ([string]$proactiveOutbox.nextCursor)
} finally {
    foreach ($process in @($serverA, $serverB)) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $dataDir) {
        Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $env:RABILINK_RELAY_DATA_DIR = $previousRelayDataDir
    $env:RABILINK_RELAY_HOST = $previousRelayHost
    $env:RABILINK_RELAY_PORT = $previousRelayPort
}
