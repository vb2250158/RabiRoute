param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseId
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallRoot)
if ($ReleaseId -notmatch '^\d+\.\d+\.\d+-[a-f0-9]{12}$' -or $root.Contains('"')) { throw 'Invalid RabiRoute upgrade target.' }
$pointer = Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw | ConvertFrom-Json
if ($pointer.releaseId -ne $ReleaseId -or $pointer.versionPath -ne "versions/$ReleaseId") { return }
$policyPath = Join-Path $root 'data\rabilink\host-upgrade.json'
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
if ($policy.enabled -ne $true) { return }
$package = Join-Path $root "versions\$ReleaseId"
$node = Join-Path $package 'node.exe'
$script = Join-Path $package 'scripts\rabilink-host-upgrade.mjs'
if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $script -PathType Leaf)) { throw 'Upgrade runtime is absent from the installed release.' }

$hasher = [Security.Cryptography.SHA256]::Create()
try { $id = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
finally { $hasher.Dispose() }
$name = "RabiRoute-HostUpgrade-$id"
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task.State -eq 'Running') { return }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" "{1}" "{2}"' -f $script, $root.TrimEnd('\'), $ReleaseId) -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
try {
    Register-ScheduledTask -TaskName $name -Principal $principal -Action $action -Settings $settings -Force -ErrorAction Stop | Out-Null
} catch {
    throw "RabiLink host upgrade task registration failed: $($_.Exception.Message)"
}
try {
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
} catch {
    throw "RabiLink host upgrade task start failed: $($_.Exception.Message)"
}
