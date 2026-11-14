[CmdletBinding()]
param(
    [string]$HomeAssistantBaseUrl = "",
    # Retained for existing callers; credentials are checked by Manager and never forwarded here.
    [string]$TokenEnvironment = "RABIROUTE_XIAOMI_HOME_HA_TOKEN",
    [string]$ArtifactTokenEnvironment = "RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN",
    [string]$ManagerBaseUrl = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Resolve-RabiRouteManagerUrl.ps1")
$ManagerBaseUrl = Resolve-RabiRouteManagerUrl -ExplicitUrl $ManagerBaseUrl

function Get-HttpOrigin {
    param([string]$Value)
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @("http", "https") -or $uri.UserInfo -or
        $uri.AbsolutePath -ne "/" -or $uri.Query -or $uri.Fragment) {
        throw "Home Assistant URL must be an HTTP(S) origin without credentials, path, query or fragment."
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
}

function Test-TcpEndpoint {
    param([Parameter(Mandatory)][Uri]$Uri)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.BeginConnect($Uri.Host, $Uri.Port, $null, $null)
        return $connect.AsyncWaitHandle.WaitOne(800) -and $client.Connected
    } catch { return $false }
    finally { $client.Dispose() }
}

function Read-ManagerJson {
    param([string]$Path)
    # No HA credential enters the diagnostic process or a redirected HTTP request.
    return Invoke-RestMethod -Uri "$ManagerBaseUrl$Path" -MaximumRedirection 0 -TimeoutSec 15
}

function Assert-ManagerIdentity {
    param($Meta, $Expected = $null)
    foreach ($name in @("applicationGenerationId", "managerInstanceId", "managerBaseUrl")) {
        if ($Meta.$name -isnot [string] -or [string]::IsNullOrWhiteSpace($Meta.$name)) {
            throw "Manager returned an incomplete identity."
        }
    }
    if ((Get-HttpOrigin $Meta.managerBaseUrl) -ne $ManagerBaseUrl -or
        $Meta.health.live -ne $true -or $Meta.health.state -notin @("healthy", "degraded")) {
        throw "Manager identity is unavailable or does not match the discovered endpoint."
    }
    if ($null -ne $Expected -and
        ($Meta.applicationGenerationId -ne $Expected.applicationGenerationId -or
         $Meta.managerInstanceId -ne $Expected.managerInstanceId)) {
        throw "Manager lifecycle changed during the check; rediscover and rerun."
    }
}

$before = Read-ManagerJson "/meta"
Assert-ManagerIdentity $before
$healthResponse = Read-ManagerJson "/api/agent/xiaomi-home/health"
$deploymentResponse = Read-ManagerJson "/api/agent/xiaomi-home/deployment"
if ($healthResponse.code -ne 0 -or $null -eq $healthResponse.data -or
    $deploymentResponse.code -ne 0 -or $null -eq $deploymentResponse.data) {
    throw "The current Manager could not inspect its Xiaomi Home integration."
}
Assert-ManagerIdentity (Read-ManagerJson "/meta") $before
$health = $healthResponse.data
$deployment = $deploymentResponse.data
$ownerBaseUrl = ""
if ($health.baseUrl -and $health.baseUrl -ne "http://127.0.0.1:1") {
    $ownerBaseUrl = Get-HttpOrigin $health.baseUrl
} elseif ($deployment.state -eq "ready" -and $deployment.baseUrl) {
    $ownerBaseUrl = Get-HttpOrigin $deployment.baseUrl
}
$explicit = -not [string]::IsNullOrWhiteSpace($HomeAssistantBaseUrl)
$checkedBaseUrl = if ($explicit) { Get-HttpOrigin $HomeAssistantBaseUrl } else { $ownerBaseUrl }
$authenticationChecked = -not $explicit -or ($ownerBaseUrl -and $checkedBaseUrl -eq $ownerBaseUrl)
$authenticated = if ($authenticationChecked) { $health.status -eq "ready" } else { $null }
$reachable = if ($explicit) {
    Test-TcpEndpoint -Uri ([Uri]$checkedBaseUrl)
} else {
    $health.status -in @("ready", "authorization_failed") -or $deployment.state -eq "ready"
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $ffmpeg -or -not $ffprobe) {
    $toolRoot = Join-Path $env:LOCALAPPDATA "RabiRoute\tools\ffmpeg"
    if (Test-Path -LiteralPath $toolRoot) {
        if (-not $ffmpeg) { $ffmpeg = Get-ChildItem -LiteralPath $toolRoot -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if (-not $ffprobe) { $ffprobe = Get-ChildItem -LiteralPath $toolRoot -Recurse -Filter "ffprobe.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 }
    }
}
$firmwareEnabled = $null
$hypervisorPresent = $null
try {
    $processors = @(Get-CimInstance -ClassName Win32_Processor)
    $firmwareEnabled = $processors.Count -gt 0 -and @($processors | Where-Object VirtualizationFirmwareEnabled).Count -eq $processors.Count
    $hypervisorPresent = [bool](Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent
} catch { # Unknown remains distinct from false when CIM is unavailable.
}

$nextAction = if (-not $authenticationChecked) {
    "The explicit URL received a network check only. Configure and verify its connection in Rabi before checking authorization."
} elseif (-not $reachable) {
    "Inspect the Home Assistant deployment status in Rabi and start or repair the configured instance."
} elseif (-not $health.tokenConfigured -or $health.status -in @("authorization_required", "authorization_failed")) {
    "Connect or renew Home Assistant authorization in the trusted Rabi settings page."
} elseif (-not $authenticated) {
    "Inspect the Home Assistant connection reported by the current Rabi Manager."
} elseif ($health.cameraCapture.enabled -and -not $health.cameraCapture.ready) {
    "Inspect camera capture readiness in Rabi; ffmpeg is required and ffprobe is optional metadata tooling."
} else {
    "Home Assistant connection prerequisites are ready. Verify camera entities, event delivery and actual recordings separately."
}

[ordered]@{
    checkedAt = [DateTimeOffset]::Now.ToString("o")
    homeAssistant = [ordered]@{
        baseUrl = $checkedBaseUrl
        source = if ($explicit) { "explicit-network-check" } else { "manager-owner" }
        reachable = [bool]$reachable
        authenticated = $authenticated
        authenticationChecked = [bool]$authenticationChecked
        tokenConfigured = if ($authenticationChecked) { [bool]$health.tokenConfigured } else { $null }
        credentialSource = if ($authenticationChecked) { $health.credentialSource } else { "not_checked" }
        status = if ($authenticationChecked) { $health.status } else { "not_checked" }
        deploymentState = $deployment.state
    }
    rabiRouteManager = [ordered]@{
        baseUrl = $ManagerBaseUrl
        reachable = $true
        applicationGenerationId = $before.applicationGenerationId
        managerInstanceId = $before.managerInstanceId
    }
    cameraArtifacts = [ordered]@{
        access = "manager-owner"
        ffmpegAvailable = [bool]$ffmpeg
        ffprobeAvailable = [bool]$ffprobe
        ffprobeRequired = $false
        capture = $health.cameraCapture
    }
    windowsVirtualization = [ordered]@{
        firmwareEnabled = $firmwareEnabled
        hypervisorPresent = $hypervisorPresent
    }
    nextAction = $nextAction
} | ConvertTo-Json -Depth 8
