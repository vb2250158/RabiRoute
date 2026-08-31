[CmdletBinding()]
param(
    [string]$HomeAssistantBaseUrl = "http://127.0.0.1:8123",
    [string]$TokenEnvironment = "RABIROUTE_XIAOMI_HOME_HA_TOKEN",
    [string]$ArtifactTokenEnvironment = "RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN",
    [string]$ManagerBaseUrl = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Resolve-RabiRouteManagerUrl.ps1")
$ManagerBaseUrl = Resolve-RabiRouteManagerUrl -ExplicitUrl $ManagerBaseUrl

function Test-TcpEndpoint {
    param([Parameter(Mandatory)][Uri]$Uri)
    $xiaomiPort = if ($Uri.Port -gt 0) { $Uri.Port } elseif ($Uri.Scheme -eq "https") { 443 } else { 80 }
    $xiaomiClient = [System.Net.Sockets.TcpClient]::new()
    try {
        $xiaomiConnect = $xiaomiClient.BeginConnect($Uri.Host, $xiaomiPort, $null, $null)
        return $xiaomiConnect.AsyncWaitHandle.WaitOne(800) -and $xiaomiClient.Connected
    }
    catch {
        return $false
    }
    finally {
        $xiaomiClient.Dispose()
    }
}

function Test-JsonApi {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [hashtable]$Headers = @{}
    )
    try {
        Invoke-RestMethod -Uri $Uri -Headers $Headers -TimeoutSec 4 | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

$xiaomiHaUri = [Uri]$HomeAssistantBaseUrl
$xiaomiManagerUri = [Uri]$ManagerBaseUrl
$xiaomiToken = [Environment]::GetEnvironmentVariable($TokenEnvironment, "Process")
if ([string]::IsNullOrWhiteSpace($xiaomiToken)) {
    $xiaomiToken = [Environment]::GetEnvironmentVariable($TokenEnvironment, "User")
}
$xiaomiArtifactToken = [Environment]::GetEnvironmentVariable($ArtifactTokenEnvironment, "Process")
if ([string]::IsNullOrWhiteSpace($xiaomiArtifactToken)) {
    $xiaomiArtifactToken = [Environment]::GetEnvironmentVariable($ArtifactTokenEnvironment, "User")
}
$xiaomiFfmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
$xiaomiFfprobeCommand = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $xiaomiFfmpegCommand -or -not $xiaomiFfprobeCommand) {
    $xiaomiToolRoot = Join-Path $env:LOCALAPPDATA "RabiRoute\tools\ffmpeg"
    if (Test-Path -LiteralPath $xiaomiToolRoot) {
        $xiaomiFfmpegCommand = Get-ChildItem -LiteralPath $xiaomiToolRoot -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        $xiaomiFfprobeCommand = Get-ChildItem -LiteralPath $xiaomiToolRoot -Recurse -Filter "ffprobe.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
}

$xiaomiVirtualizationFirmware = $null
$xiaomiHypervisorPresent = $null
try {
    $xiaomiProcessors = @(Get-CimInstance -ClassName Win32_Processor)
    $xiaomiVirtualizationFirmware = $xiaomiProcessors.Count -gt 0 -and @($xiaomiProcessors | Where-Object VirtualizationFirmwareEnabled).Count -eq $xiaomiProcessors.Count
    $xiaomiHypervisorPresent = [bool](Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent
}
catch {
    # CIM can be unavailable in constrained shells. Unknown is kept distinct from false.
}

$xiaomiHaReachable = Test-TcpEndpoint -Uri $xiaomiHaUri
$xiaomiManagerReachable = Test-TcpEndpoint -Uri $xiaomiManagerUri
$xiaomiHaAuthenticated = $false
if ($xiaomiHaReachable -and -not [string]::IsNullOrWhiteSpace($xiaomiToken)) {
    $xiaomiHaAuthenticated = Test-JsonApi -Uri "$($xiaomiHaUri.AbsoluteUri.TrimEnd('/'))/api/" -Headers @{ Authorization = "Bearer $xiaomiToken" }
}

$xiaomiResult = [ordered]@{
    checkedAt = [DateTimeOffset]::Now.ToString("o")
    homeAssistant = [ordered]@{
        baseUrl = $xiaomiHaUri.AbsoluteUri.TrimEnd("/")
        reachable = $xiaomiHaReachable
        tokenEnvironment = $TokenEnvironment
        tokenConfigured = -not [string]::IsNullOrWhiteSpace($xiaomiToken)
        authenticated = $xiaomiHaAuthenticated
    }
    rabiRouteManager = [ordered]@{
        baseUrl = $xiaomiManagerUri.AbsoluteUri.TrimEnd("/")
        reachable = $xiaomiManagerReachable
    }
    cameraArtifacts = [ordered]@{
        readTokenEnvironment = $ArtifactTokenEnvironment
        readTokenConfigured = -not [string]::IsNullOrWhiteSpace($xiaomiArtifactToken)
        ffmpegAvailable = [bool]$xiaomiFfmpegCommand
        ffprobeAvailable = [bool]$xiaomiFfprobeCommand
    }
    windowsVirtualization = [ordered]@{
        firmwareEnabled = $xiaomiVirtualizationFirmware
        hypervisorPresent = $xiaomiHypervisorPresent
    }
    nextAction = if (-not $xiaomiHaReachable) {
        "Install or start Home Assistant on a local host/VM, then rerun this check."
    } elseif ([string]::IsNullOrWhiteSpace($xiaomiToken)) {
        "Create a Home Assistant long-lived access token in its trusted UI and set only the named local environment variable."
    } elseif (-not $xiaomiHaAuthenticated) {
        "Verify the Home Assistant URL and token without pasting the token into chat or repository files."
    } elseif (-not $xiaomiManagerReachable) {
        "Start the locally installed RabiRoute Manager and verify the Xiaomi Home health endpoint."
    } else {
        "Prerequisites are ready; enumerate resources and keep writeEnabled=false for read-only acceptance."
    }
}

$xiaomiResult | ConvertTo-Json -Depth 5
