function Resolve-RabiRouteManagerUrl {
    [CmdletBinding()]
    param([string]$ExplicitUrl = "")

    $candidate = $ExplicitUrl.Trim()
    if (-not $candidate) { $candidate = ([string]$env:RABIROUTE_MANAGER_URL).Trim() }
    if (-not $candidate) { $candidate = ([string]$env:GATEWAY_MANAGER_URL).Trim() }
    if (-not $candidate) {
        $hostExe = ([string]$env:RABIROUTE_HOST_EXE).Trim()
        if (-not $hostExe) {
            $hostExe = Join-Path ([string]$env:LOCALAPPDATA) "Programs\RabiRoute\RabiRouteHost.exe"
        }
        if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
            throw "RabiRoute Host is not installed; set RABIROUTE_MANAGER_URL explicitly."
        }
        $statusText = & $hostExe --command status --json
        if ($LASTEXITCODE -ne 0) { throw "RabiRoute Host is offline or did not return a healthy status." }
        try { $status = $statusText | ConvertFrom-Json } catch { throw "RabiRoute Host returned invalid status JSON." }
        if ($status.ok -ne $true -or $status.state -ne "healthy" -or -not $status.managerBaseUrl -or -not $status.applicationGenerationId -or -not $status.managerInstanceId) {
            throw "RabiRoute Host has not published a healthy, complete Manager READY identity."
        }
        $candidate = [string]$status.managerBaseUrl
    }

    try { $uri = [Uri]$candidate } catch { throw "Manager URL is invalid." }
    if ($uri.Scheme -ne "http" -or $uri.Host -notin @("127.0.0.1", "localhost", "::1") -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
        throw "Manager URL must be an HTTP loopback URL without credentials."
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
}
