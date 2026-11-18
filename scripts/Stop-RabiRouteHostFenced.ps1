param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$WorkingRoot
)

$ErrorActionPreference = "Stop"

function Resolve-HostQuitFence([object]$Status) {
    $state = ([string]$Status.state).Trim().ToLowerInvariant()
    $applicationGeneration = ([string]$Status.applicationGenerationId).Trim()

    if ($state -in @("healthy", "degraded")) {
        if ([string]::IsNullOrWhiteSpace($applicationGeneration)) {
            throw "Host state '$state' omitted applicationGenerationId; refusing fenced quit."
        }
        return [pscustomobject]@{ generationId = $applicationGeneration; source = "applicationGenerationId" }
    }

    if ($state -eq "faulted") {
        if (-not [string]::IsNullOrWhiteSpace($applicationGeneration)) {
            return [pscustomobject]@{ generationId = $applicationGeneration; source = "applicationGenerationId" }
        }
        $controlFence = ([string]$Status.controlFenceGenerationId).Trim()
        if ([string]::IsNullOrWhiteSpace($controlFence)) {
            throw "Faulted Host status omitted controlFenceGenerationId; refusing fenced quit."
        }
        return [pscustomobject]@{ generationId = $controlFence; source = "controlFenceGenerationId" }
    }

    throw "Unsupported Host state '$state'; refusing fenced quit."
}

function Repair-ChildProcessEnvironment {
    # .NET Framework enumerates case-sensitive names, but Start-Process copies
    # them into a case-insensitive dictionary when redirecting output. Validate
    # every group before changing this process; never choose between values.
    $groups = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $name = [string]$entry.Key
        if (-not $groups.ContainsKey($name)) { $groups.Add($name, [Collections.Generic.List[object]]::new()) }
        $groups[$name].Add($entry)
    }
    foreach ($entries in $groups.Values) {
        foreach ($entry in $entries) {
            if (-not [string]::Equals([string]$entry.Value, [string]$entries[0].Value, [StringComparison]::Ordinal)) {
                throw "Conflicting case-insensitive environment variable: $($entries[0].Key). Align its values in the launching environment and retry. Values are not logged."
            }
        }
    }
    foreach ($entries in $groups.Values) {
        # Windows removes one case-insensitive match at a time. Leave one
        # original entry untouched, including an explicitly empty value.
        for ($i = 1; $i -lt $entries.Count; $i++) {
            [Environment]::SetEnvironmentVariable([string]$entries[0].Key, $null, 'Process')
        }
    }
}

function Invoke-HostJson([string]$HostPath, [string[]]$Arguments, [string]$Work) {
    [IO.Directory]::CreateDirectory($Work) | Out-Null
    $id = [guid]::NewGuid().ToString("N")
    $stdout = Join-Path $Work "$id.stdout.txt"
    $stderr = Join-Path $Work "$id.stderr.txt"
    $succeeded = $false
    try {
        try {
            Repair-ChildProcessEnvironment
            $process = Start-Process -FilePath $HostPath -ArgumentList $Arguments -WorkingDirectory (Split-Path -Parent $HostPath) `
                -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru
        } catch {
            $launchError = Join-Path $Work "$id.launch-error.txt"
            [IO.File]::WriteAllText($launchError, ($_.Exception.ToString() + "`n" + $_.InvocationInfo.PositionMessage + "`n" + $_.ScriptStackTrace))
            throw "Host command failed before exit. stdout=$stdout; stderr=$stderr; launchError=$launchError"
        }
        if ($null -eq $process.ExitCode) { throw "Host command failed (ExitCode=unknown). stdout=$stdout; stderr=$stderr" }
        if ($process.ExitCode -ne 0) { throw "Host command failed (ExitCode=$($process.ExitCode)). stdout=$stdout; stderr=$stderr" }
        $out = if (Test-Path -LiteralPath $stdout) { [IO.File]::ReadAllText($stdout) } else { "" }
        try { $json = $out.Trim() | ConvertFrom-Json } catch { throw "Host command returned invalid JSON. stdout=$stdout; stderr=$stderr" }
        if ($null -eq $json -or $json.ok -ne $true) { throw "Host command did not return ok:true. stdout=$stdout; stderr=$stderr" }
        $succeeded = $true
        return $json
    } finally {
        if ($succeeded) { Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue }
    }
}

function Get-OriginalHostProcesses([object]$Status, [string]$HostPath) {
    $children = @()
    foreach ($name in @("managerPid", "trayPid")) {
        $processId = [uint32]$Status.$name
        if (-not $processId) { continue }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
        if ($process) { $children += $process }
    }
    $parents = @($children | ForEach-Object { [uint32]$_.ParentProcessId } | Select-Object -Unique)
    if ($parents.Count -ne 1) { throw "Cannot identify a shared original Host parent from the status-owned processes." }
    $hostName = [IO.Path]::GetFileName($HostPath)
    $hosts = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($parents[0])" -ErrorAction Stop)
    $hosts = @($hosts | Where-Object {
        [string]::Equals($_.Name, $hostName, [StringComparison]::OrdinalIgnoreCase) -and
        (-not $_.ExecutablePath -or
            [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $HostPath, [StringComparison]::OrdinalIgnoreCase)) -and
        $_.CommandLine -notmatch '(?i)(?:^|\s)--command(?:\s|$)'
    })
    if ($hosts.Count -ne 1) { throw "Cannot identify the original Host process before fenced quit." }
    foreach ($process in @($hosts[0]) + $children) {
        if (-not $process.CreationDate) { throw "Original process $($process.ProcessId) omitted CreationDate." }
        [pscustomobject]@{
            role = $(if ($process.ProcessId -eq $hosts[0].ProcessId) { "Host" }
                elseif ($process.ProcessId -eq $Status.managerPid) { "Manager" } else { "Tray" })
            processId = [uint32]$process.ProcessId
            creationDate = ([datetime]$process.CreationDate).ToUniversalTime().Ticks
            identityMethod = $(if ($process.ProcessId -eq $hosts[0].ProcessId -and $process.ExecutablePath) {
                "status-child-parent-and-host-path"
            } else { "status-child-parent-and-name" })
        }
    }
}

function Wait-OriginalHostProcesses([object[]]$Processes, [int]$TimeoutMilliseconds = 45000) {
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    do {
        $remaining = @($Processes | Where-Object {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.processId)" -ErrorAction Stop
            if ($current -and -not $current.CreationDate) { throw "Cannot confirm original process $($_.processId) exit without CreationDate." }
            $current -and ([datetime]$current.CreationDate).ToUniversalTime().Ticks -eq $_.creationDate
        })
        if (-not $remaining.Count) { return }
        if ($elapsed.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
            throw "Original Host generation processes did not exit after fenced quit: $($remaining.processId -join ', ')."
        }
        Start-Sleep -Milliseconds 250
    } while ($true)
}

$install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$hostPath = Join-Path $install "RabiRouteHost.exe"
if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
    [pscustomobject]@{ ok = $true; state = "absent" } | ConvertTo-Json -Compress
    exit 0
}
if (-not $WorkingRoot) { $WorkingRoot = Join-Path $install ".install-staging\host-control" }
$status = Invoke-HostJson $hostPath @("--command", "status", "--json") $WorkingRoot
if ([string]$status.state -eq "stopped") {
    [pscustomobject]@{ ok = $true; state = "stopped" } | ConvertTo-Json -Compress
    exit 0
}
$fence = Resolve-HostQuitFence $status
$generation = [string]$fence.generationId
$originalProcesses = @(Get-OriginalHostProcesses $status $hostPath)
$confirmed = Invoke-HostJson $hostPath @("--command", "status", "--json") $WorkingRoot
$confirmedFence = Resolve-HostQuitFence $confirmed
if ([string]$confirmedFence.generationId -ne $generation -or
    [int]$confirmed.managerPid -ne [int]$status.managerPid -or [int]$confirmed.trayPid -ne [int]$status.trayPid) {
    throw "Host generation changed while capturing process identities."
}
$quit = Invoke-HostJson $hostPath @("--command", "quit", "--application-generation-id", $generation, "--json") $WorkingRoot
if ([string]$quit.state -ne "stopped") { throw "Fenced quit did not reach state=stopped." }
Wait-OriginalHostProcesses $originalProcesses
[pscustomobject]@{ ok = $true; state = "stopped"; applicationGenerationId = $generation; fenceSource = [string]$fence.source; originalProcesses = $originalProcesses } | ConvertTo-Json -Depth 4 -Compress
