param(
    [Parameter(Mandatory)][string]$Node,
    [string]$ApplicationRoot,
    [Parameter(Mandatory)][string]$OwnerSid,
    [Parameter(Mandatory)][string]$WorkBuddyHome,
    [switch]$Interactive,
    [switch]$RestartUnmanaged
)
$ErrorActionPreference = 'Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $OwnerSid) {
    throw 'WorkBuddy desktop launcher resolved a different Windows user.'
}
if (![IO.Path]::IsPathRooted($WorkBuddyHome)) { throw 'WorkBuddy desktop launcher needs an absolute state directory.' }

function Get-DesktopWorkBuddyProcesses {
    Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" | Where-Object {
        $_.SessionId -eq $sessionId -and $_.ExecutablePath -ieq $installedWorkBuddy
    }
}
$installedWorkBuddy = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe'))
$sessionId = (Get-Process -Id $PID).SessionId
$standalone = $null
if (!$Interactive) {
    $clients = @(Get-DesktopWorkBuddyProcesses)
    if ($clients.Count) {
        $roots = @($clients | Where-Object { $_.ParentProcessId -notin $clients.ProcessId -and $_.CommandLine -notmatch '\s--type=' })
        if ($roots.Count -eq 1 -and $roots[0].CommandLine -match '\s--remote-debugging-pipe(?:\s|$)') { exit 42 }
        if (!$RestartUnmanaged -or $roots.Count -ne 1 -or !$roots[0].CommandLine) { exit 41 }
        $standalone = $roots[0]
    }
}

$package = Split-Path -Parent $PSScriptRoot
$worker = Get-Item -LiteralPath (Join-Path $package 'workers/desktop-companion.mjs')
$nodeFile = Get-Item -LiteralPath $Node
if ($nodeFile.PSIsContainer -or $worker.PSIsContainer) {
    throw 'WorkBuddy desktop launcher needs the packaged worker and Node executable.'
}
function Get-ExecutableDigest([string]$Path) {
    $file = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($algorithm.ComputeHash($file)) }
    finally { $algorithm.Dispose(); $file.Dispose() }
}
if ($nodeFile.Name -ieq 'RabiRoute.Runtime.exe') {
    if (!$ApplicationRoot -or ![IO.Path]::IsPathRooted($ApplicationRoot)) {
        throw 'WorkBuddy desktop launcher needs the active release directory.'
    }
    $release = Get-Item -LiteralPath $ApplicationRoot
    if (!$release.PSIsContainer -or $release.Parent.Name -ine 'versions') {
        throw 'WorkBuddy desktop launcher needs an installed RabiRoute release.'
    }
    $stableRuntime = Join-Path $release.Parent.Parent.FullName 'runtime/RabiRoute.Runtime.exe'
    if ($nodeFile.FullName -ine [IO.Path]::GetFullPath($stableRuntime)) {
        throw 'WorkBuddy desktop launcher refused a runtime outside this installation.'
    }
    $releaseNode = Get-Item -LiteralPath (Join-Path $release.FullName 'node.exe')
    if ($releaseNode.PSIsContainer -or (Get-ExecutableDigest $nodeFile.FullName) -ne (Get-ExecutableDigest $releaseNode.FullName)) {
        throw 'The installed RabiRoute runtime does not match the active release Node executable.'
    }
    $nodeFile = $releaseNode
} elseif ($nodeFile.Name -ine 'node.exe') {
    throw 'WorkBuddy desktop launcher needs the packaged worker and Node executable.'
}
if ($Interactive) {
    # This process is a child of Explorer and retains the desktop across Host cutovers.
    $mutex = [System.Threading.Mutex]::new($false, "Local\RabiRoute.WorkBuddy.Desktop.$OwnerSid")
    try {
        $acquired = $false
        try { $acquired = $mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $acquired = $true }
        if (!$acquired) { return }
        try {
            $env:RABI_WORKBUDDY_HOME = $WorkBuddyHome
            & $nodeFile.FullName $worker.FullName
            exit $LASTEXITCODE
        } finally { $mutex.ReleaseMutex() }
    } finally { $mutex.Dispose() }
}

# Ask the current desktop shell to start the connector under its original user token.
$shell = New-Object -ComObject Shell.Application
$windows = $shell.Windows()
[int]$hwnd = 0
$desktop = $windows.FindWindowSW(0, 0, 8, [ref]$hwnd, 1)
if (!$desktop -or !$hwnd) { throw 'The logged-in Windows desktop shell is unavailable.' }
if ($standalone) {
    $current = @(Get-DesktopWorkBuddyProcesses | Where-Object { $_.ProcessId -eq $standalone.ProcessId })
    if ($current.Count -ne 1 -or $current[0].CreationDate -ne $standalone.CreationDate -or $current[0].CommandLine -ne $standalone.CommandLine) { exit 41 }
    $owner = Invoke-CimMethod -InputObject $current[0] -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $OwnerSid) { exit 41 }
    $client = Get-Process -Id $standalone.ProcessId -ErrorAction Stop
    if ($client.Path -ine $installedWorkBuddy -or [Math]::Abs(($client.StartTime.ToUniversalTime() - $standalone.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1) { exit 41 }
    Stop-Process -InputObject $client -Force -ErrorAction Stop
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while (@(Get-DesktopWorkBuddyProcesses).Count) {
        if ($wait.Elapsed.TotalSeconds -gt 7) { throw 'WorkBuddy did not release its desktop session for restart.' }
        Start-Sleep -Milliseconds 250
    }
}
$powerShell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -STA -WindowStyle Hidden -File "' + $PSCommandPath +
    '" -Node "' + $nodeFile.FullName + '" -OwnerSid "' + $OwnerSid + '" -WorkBuddyHome "' + $WorkBuddyHome + '" -Interactive'
$desktop.Document.Application.ShellExecute($powerShell, $arguments, $package, 'open', 0)
