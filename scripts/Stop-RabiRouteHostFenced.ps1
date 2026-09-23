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
$quit = Invoke-HostJson $hostPath @("--command", "quit", "--application-generation-id", $generation, "--json") $WorkingRoot
if ([string]$quit.state -ne "stopped") { throw "Fenced quit did not reach state=stopped." }
$after = Invoke-HostJson $hostPath @("--command", "status", "--json") $WorkingRoot
if ([string]$after.state -ne "stopped") { throw "Host remained active after fenced quit." }
[pscustomobject]@{ ok = $true; state = "stopped"; applicationGenerationId = $generation; fenceSource = [string]$fence.source } | ConvertTo-Json -Compress
