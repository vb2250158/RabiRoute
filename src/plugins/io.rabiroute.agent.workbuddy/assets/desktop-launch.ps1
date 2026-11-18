param(
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$OwnerSid,
    [Parameter(Mandatory)][string]$WorkBuddyHome,
    [switch]$Interactive
)
$ErrorActionPreference = 'Stop'
$package = Split-Path -Parent $PSScriptRoot
$worker = Get-Item -LiteralPath (Join-Path $package 'workers/desktop-companion.mjs')
$nodeFile = Get-Item -LiteralPath $Node
if ($nodeFile.Name -ne 'node.exe' -or $nodeFile.PSIsContainer -or $worker.PSIsContainer) {
    throw 'WorkBuddy desktop launcher needs the packaged worker and Node executable.'
}
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $OwnerSid) {
    throw 'WorkBuddy desktop launcher resolved a different Windows user.'
}
if (![IO.Path]::IsPathRooted($WorkBuddyHome)) { throw 'WorkBuddy desktop launcher needs an absolute state directory.' }

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
$powerShell = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -STA -WindowStyle Hidden -File "' + $PSCommandPath +
    '" -Node "' + $nodeFile.FullName + '" -OwnerSid "' + $OwnerSid + '" -WorkBuddyHome "' + $WorkBuddyHome + '" -Interactive'
$desktop.Document.Application.ShellExecute($powerShell, $arguments, $package, 'open', 0)
