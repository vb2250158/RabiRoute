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

function Get-GenerationProcessHandles([object]$Status) {
    $managerId = [int]$Status.managerPid
    $trayId = [int]$Status.trayPid
    if ($managerId -le 0 -or $trayId -le 0) { throw "Healthy Host status omitted Manager or Tray identity." }
    $manager = Get-CimInstance Win32_Process -Filter "ProcessId=$managerId" -ErrorAction Stop
    $tray = Get-CimInstance Win32_Process -Filter "ProcessId=$trayId" -ErrorAction Stop
    if ($null -eq $manager -or $null -eq $tray -or $manager.ParentProcessId -le 0 -or $manager.ParentProcessId -ne $tray.ParentProcessId) {
        throw "Manager and Tray do not share a provable Host parent."
    }
    $hostId = [int]$manager.ParentProcessId
    $hostInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$hostId" -ErrorAction Stop
    if ($null -eq $hostInfo -or $hostInfo.Name -ine "RabiRouteHost.exe") { throw "Generation Host process identity is unavailable." }
    $members = @($Status.jobMemberPids | ForEach-Object { [int]$_ })
    if ($managerId -notin $members -or $trayId -notin $members) { throw "Host job does not contain its READY Manager and Tray." }
    $result = [Collections.Generic.List[object]]::new()
    try {
        foreach ($id in @(@($hostId) + $members | Select-Object -Unique)) {
            $process = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($null -eq $process) {
                if ($id -in @($hostId, $managerId, $trayId)) { throw "A required generation process exited before its handle was captured." }
                continue
            }
            $handle = $process.Handle
            if ($handle -eq [IntPtr]::Zero) { throw "Could not retain an exact generation process handle." }
            $result.Add($process)
        }
        return ,$result.ToArray()
    } catch {
        foreach ($process in $result) { $process.Dispose() }
        throw
    }
}

function Wait-GenerationProcessExit([object[]]$Processes, [int]$TimeoutMs = 30000) {
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    foreach ($process in $Processes) {
        if ($process.HasExited) { continue }
        $remaining = $TimeoutMs - [int]$elapsed.ElapsedMilliseconds
        if ($remaining -le 0 -or -not $process.WaitForExit($remaining)) {
            throw "The original Host generation did not fully exit before the deadline."
        }
    }
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
$handles = @()
try {
    if ([string]$status.state -in @("healthy", "degraded")) {
        $handles = @(Get-GenerationProcessHandles $status)
        $confirmed = Invoke-HostJson $hostPath @("--command", "status", "--json") $WorkingRoot
        if ([string]$confirmed.applicationGenerationId -ne $generation -or
            [int]$confirmed.managerPid -ne [int]$status.managerPid -or [int]$confirmed.trayPid -ne [int]$status.trayPid) {
            throw "Host generation changed while capturing process handles."
        }
    }
    $quit = Invoke-HostJson $hostPath @("--command", "quit", "--application-generation-id", $generation, "--json") $WorkingRoot
    if ([string]$quit.state -ne "stopped") { throw "Fenced quit did not reach state=stopped." }
    if ($handles.Count -gt 0) {
        # The bootstrap read-only status probe reports unknown after its pipe closes.
        # Retained OS handles establish exit of the original processes without a PID-reuse race.
        Wait-GenerationProcessExit $handles
    } else {
        # Keep the previous fail-closed behavior for faulted generations without READY children.
        $after = Invoke-HostJson $hostPath @("--command", "status", "--json") $WorkingRoot
        if ([string]$after.state -ne "stopped") { throw "Host remained active after fenced quit." }
    }
} finally {
    foreach ($process in $handles) { $process.Dispose() }
}
[pscustomobject]@{ ok = $true; state = "stopped"; applicationGenerationId = $generation; fenceSource = [string]$fence.source } | ConvertTo-Json -Compress
