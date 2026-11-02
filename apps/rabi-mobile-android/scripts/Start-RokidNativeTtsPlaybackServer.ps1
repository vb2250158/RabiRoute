param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string]$ReadyFile = "",
    [string[]]$Paths = @("/api/fennenote/playback", "/api/rokid/tts"),
    [string]$TtsCommand = "tts",
    [int]$CommandWaitSeconds = 3,
    [switch]$DryRun,
    [switch]$Once
)

$ErrorActionPreference = "Stop"

$sendScript = Join-Path $PSScriptRoot "Send-RokidNativeVoiceCommand.ps1"
if (-not (Test-Path -LiteralPath $sendScript)) {
    throw "TTS 命令脚本不存在：$sendScript"
}

function Read-RequestBody {
    param([System.Net.HttpListenerRequest]$Request)

    $reader = [System.IO.StreamReader]::new($Request.InputStream, [System.Text.Encoding]::UTF8)
    try {
        return $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }
}

function Write-JsonResponse {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [object]$Payload
    )

    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.Close()
}

function Value-String {
    param([object]$Value)

    if ($null -eq $Value) {
        return ""
    }
    return ([string]$Value).Trim()
}

function Read-Property {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) {
        return $Object[$Name]
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Resolve-SpeechText {
    param([object]$Body)

    foreach ($name in @("ttsText", "text", "message", "content", "visibleText")) {
        $value = Value-String (Read-Property -Object $Body -Name $name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }

    $payload = Read-Property -Object $Body -Name "payload"
    foreach ($name in @("ttsText", "text", "message", "content", "visibleText")) {
        $value = Value-String (Read-Property -Object $payload -Name $name)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
    }

    return ""
}

function Invoke-RokidTts {
    param([string]$Text)

    if ($DryRun) {
        return [ordered]@{
            ok = $true
            acknowledged = $false
            status = "dry_run"
            command = $TtsCommand
            text = $Text
        }
    }

    $commandParams = @{
        Command = $TtsCommand
        Text = $Text
        WaitSeconds = $CommandWaitSeconds
    }
    if (-not [string]::IsNullOrWhiteSpace($Serial)) {
        $commandParams.Serial = $Serial
    }
    if (-not [string]::IsNullOrWhiteSpace($AdbPath)) {
        $commandParams.AdbPath = $AdbPath
    }

    $output = & $sendScript @commandParams
    $jsonText = ($output | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Last 1)
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        throw "Send-RokidNativeVoiceCommand.ps1 没有返回 JSON。"
    }
    return $jsonText | ConvertFrom-Json
}

$normalizedPaths = @($Paths | ForEach-Object {
    $path = $_.Trim()
    if (-not $path.StartsWith("/")) {
        $path = "/" + $path
    }
    $path
})

# Keep this list aligned with src/managerEndpointPolicy.ts: WebGUI and Node Fetch
# reject these ports even when the operating system successfully allocates them.
$fetchBlockedPorts = @(1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080)
$listener = $null
for ($attempt = 0; $attempt -lt 32; $attempt++) {
    $candidate = $Port
    if ($candidate -eq 0) {
        $reservation = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        try {
            $reservation.Start()
            $candidate = ([System.Net.IPEndPoint]$reservation.LocalEndpoint).Port
        } finally { $reservation.Stop() }
    }
    if ($candidate -in $fetchBlockedPorts) {
        if ($Port -ne 0 -or $attempt -eq 31) { throw "The requested TTS port is blocked by browser and Fetch clients." }
        continue
    }
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://127.0.0.1:$candidate/")
    try {
        $listener.Start()
        $Port = $candidate
        break
    } catch {
        $listener.Close()
        $listener = $null
        if ($Port -ne 0 -or $attempt -eq 31) { throw }
    }
}
if ($ReadyFile) {
    $ready = [ordered]@{ pid = $PID; port = $Port; playbackUrl = "http://127.0.0.1:$Port/api/fennenote/playback" }
    $pending = "$ReadyFile.$PID.pending"
    try {
        [System.IO.File]::WriteAllText($pending, ($ready | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::Move($pending, $ReadyFile)
    } catch {
        $listener.Close()
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
        throw
    }
}
Write-Host "Rokid native TTS playback server listening on http://127.0.0.1:$Port"
Write-Host "Accepted paths: $($normalizedPaths -join ', ')"
Write-Host "TTS command: $TtsCommand"

try {
    do {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $path = $request.Url.AbsolutePath

        if ($request.HttpMethod -ne "POST" -or $normalizedPaths -notcontains $path) {
            Write-JsonResponse -Response $response -StatusCode 404 -Payload ([ordered]@{
                ok = $false
                error = "unsupported endpoint"
                method = $request.HttpMethod
                path = $path
                acceptedPaths = $normalizedPaths
            })
            continue
        }

        try {
            $raw = Read-RequestBody -Request $request
            $body = if ([string]::IsNullOrWhiteSpace($raw)) { [pscustomobject]@{} } else { $raw | ConvertFrom-Json }
            $text = Resolve-SpeechText -Body $body
            if ([string]::IsNullOrWhiteSpace($text)) {
                Write-JsonResponse -Response $response -StatusCode 400 -Payload ([ordered]@{
                    ok = $false
                    error = "request has no text/ttsText/message/content/visibleText"
                })
                continue
            }

            $commandResult = Invoke-RokidTts -Text $text
            $accepted = [bool](Read-Property -Object $commandResult -Name "ok")
            $acknowledged = [bool](Read-Property -Object $commandResult -Name "acknowledged")
            $status = if ($acknowledged) { "acknowledged" } elseif ($accepted) { "requested" } else { "failed" }
            Write-JsonResponse -Response $response -StatusCode ($(if ($accepted) { 202 } else { 502 })) -Payload ([ordered]@{
                ok = $accepted
                id = "rokid-tts-" + (Get-Date -Format "yyyyMMddHHmmssfff")
                status = $status
                text = $text
                commandResult = $commandResult
            })
        } catch {
            Write-JsonResponse -Response $response -StatusCode 502 -Payload ([ordered]@{
                ok = $false
                status = "failed"
                error = $_.Exception.Message
            })
        }
    } while (-not $Once)
} finally {
    $listener.Stop()
    $listener.Close()
}
