param(
    [string]$Serial = "",
    [string]$AdbPath = "",
    [int]$Port = 8794,
    [string[]]$Paths = @("/api/fennenote/playback", "/api/playback/request", "/api/rokid/tts"),
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

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
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
