function Resolve-RabiRouteHostManagerIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$HostExe)

    $resolvedHost = [IO.Path]::GetFullPath($HostExe)
    if ($resolvedHost.StartsWith("\\") -or
        [IO.Path]::GetFileName($resolvedHost) -ne "RabiRouteHost.exe" -or
        -not (Test-Path -LiteralPath $resolvedHost -PathType Leaf)) {
        throw "HostExe must identify a local installed RabiRouteHost.exe."
    }
    try { $driveType = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($resolvedHost)).DriveType } catch {
        throw "HostExe drive type could not be verified as local."
    }
    if ($driveType -eq [IO.DriveType]::Network) {
        throw "HostExe must not run from a mapped network drive."
    }
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("rabiroute-host-status-" + [Guid]::NewGuid().ToString("N"))
    $stdoutPath = Join-Path $temporaryRoot "stdout.json"
    $stderrPath = Join-Path $temporaryRoot "stderr.txt"
    try {
        New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
        $client = Start-Process `
            -FilePath $resolvedHost `
            -ArgumentList @("--command", "status", "--json") `
            -WindowStyle Hidden `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        if ($client.ExitCode -ne 0) {
            throw "RabiRoute Host is offline or did not return a healthy status (ExitCode=$($client.ExitCode))."
        }
        $statusText = [IO.File]::ReadAllText($stdoutPath, [Text.Encoding]::UTF8).Trim()
        try { $status = $statusText | ConvertFrom-Json } catch { throw "RabiRoute Host returned invalid status JSON." }
    } finally {
        if (Test-Path -LiteralPath $temporaryRoot) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }

    if ($status.ok -ne $true -or $status.state -ne "healthy" -or
        -not $status.managerBaseUrl -or -not $status.applicationGenerationId -or -not $status.managerInstanceId) {
        throw "RabiRoute Host has not published a healthy, complete Manager READY identity."
    }
    try { $uri = [Uri][string]$status.managerBaseUrl } catch { throw "Host returned an invalid Manager URL." }
    if ($uri.Scheme -ne "http" -or $uri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]") -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or $uri.AbsolutePath -ne "/") {
        throw "Host returned a Manager URL outside the local dynamic authority contract."
    }
    $baseUrl = $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
    $headers = @{
        "x-rabiroute-expected-application-generation-id" = [string]$status.applicationGenerationId
        "x-rabiroute-expected-manager-instance-id" = [string]$status.managerInstanceId
    }
    try {
        $meta = Invoke-RestMethod -Uri "$baseUrl/meta" -Method Get -Headers $headers -TimeoutSec 5
    } catch {
        throw "RabiRoute Manager did not return a fenced identity document."
    }
    if ([string]$meta.managerBaseUrl -ne $baseUrl -or
        [string]$meta.applicationGenerationId -ne [string]$status.applicationGenerationId -or
        [string]$meta.managerInstanceId -ne [string]$status.managerInstanceId) {
        throw "RabiRoute Manager identity does not match the Host-owned application generation."
    }
    return [pscustomobject]@{
        HostExe = $resolvedHost
        ManagerBaseUrl = $baseUrl
        ApplicationGenerationId = [string]$status.applicationGenerationId
        ManagerInstanceId = [string]$status.managerInstanceId
        Headers = $headers
    }
}
