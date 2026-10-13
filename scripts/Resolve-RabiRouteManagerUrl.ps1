function Read-RabiRouteHostStatus {
    param([string]$HostExe, [int]$TimeoutMilliseconds)

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $HostExe
    $startInfo.Arguments = '--command status --json'
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        try { [void]$process.Start() } catch { throw 'RabiRoute Host status query could not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            # This owns only the short status-query child, never the running Host.
            try { $process.Kill() } catch {}
            throw 'RabiRoute Host status query timed out.'
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Resolve-RabiRouteManagerUrl {
    [CmdletBinding()]
    param(
        [string]$ExplicitUrl = "",
        [ValidateRange(1, 120000)][int]$TimeoutMilliseconds = 10000,
        [ValidateRange(1, 10000)][int]$PollIntervalMilliseconds = 250
    )

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
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $lastState = 'unknown'
        while (-not $candidate) {
            $remaining = $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds
            if ($remaining -le 0) {
                throw "RabiRoute Host has not published a complete Manager READY identity within $TimeoutMilliseconds ms (state=$lastState); startup or recovery is still pending."
            }
            $result = Read-RabiRouteHostStatus -HostExe $hostExe -TimeoutMilliseconds $remaining
            if ($result.ExitCode -ne 0) { throw "RabiRoute Host is offline or its status command failed (exit=$($result.ExitCode))." }
            try { $status = $result.Stdout | ConvertFrom-Json -ErrorAction Stop } catch { throw "RabiRoute Host returned invalid status JSON." }
            if ($null -eq $status) { throw "RabiRoute Host returned invalid status JSON." }
            if (-not $status.PSObject.Properties['ok'] -or $status.ok -ne $true) { throw 'RabiRoute Host status is unavailable (ok is not true).' }
            # Host owns publication. Aggregate state is diagnostic, not another API grant.
            $complete = $true
            foreach ($field in @('managerBaseUrl', 'applicationGenerationId', 'managerInstanceId')) {
                if (-not $status.PSObject.Properties[$field] -or $status.$field -isnot [string] -or
                    [string]::IsNullOrWhiteSpace($status.$field)) { $complete = $false; break }
            }
            if ($complete) {
                $candidate = [string]$status.managerBaseUrl
                break
            }
            $lastState = if ($status.PSObject.Properties['state']) { [string]$status.state } else { 'unknown' }
            if (-not $lastState) { $lastState = 'unknown' }
            $wait = [Math]::Min($PollIntervalMilliseconds, $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds)
            if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
        }
    }

    try { $uri = [Uri]$candidate } catch { throw "Manager URL is invalid." }
    if ($uri.Scheme -ne "http" -or $uri.Host -notin @("127.0.0.1", "localhost", "::1") -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
        throw "Manager URL must be an HTTP loopback URL without credentials."
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
}
