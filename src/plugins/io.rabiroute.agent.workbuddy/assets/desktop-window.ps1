param([string]$Executable, [int]$WorkBuddyPid, [switch]$Minimize)
$ErrorActionPreference = 'Stop'
if (-not $WorkBuddyPid) {
    $running = @(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable -and $_.MainWindowHandle -ne 0 })
    if ($running.Count) { throw 'Exit the current WorkBuddy desktop before starting the desktop connector.' }
    exit 0
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WorkBuddyDesktopWindow {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int mode);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$app = Get-Process -Id $WorkBuddyPid
if ($app.Path -ne $Executable -or $app.MainWindowHandle -eq 0) { throw 'WorkBuddy main window is not ready.' }
$window = $app.MainWindowHandle
if ($Minimize) {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ([WorkBuddyDesktopWindow]::GetForegroundWindow() -eq $window) {
            [void][WorkBuddyDesktopWindow]::ShowWindowAsync($window, 6)
        } elseif (-not [WorkBuddyDesktopWindow]::IsIconic($window)) {
            [void][WorkBuddyDesktopWindow]::ShowWindowAsync($window, 7)
        } else { break }
        Start-Sleep -Milliseconds 250
    } while ($deadline.ElapsedMilliseconds -lt 2500)
}
[uint32]$foregroundOwner = 0
[void][WorkBuddyDesktopWindow]::GetWindowThreadProcessId([WorkBuddyDesktopWindow]::GetForegroundWindow(), [ref]$foregroundOwner)
[ordered]@{ window = $window.ToInt64(); minimized = [WorkBuddyDesktopWindow]::IsIconic($window); isForeground = $foregroundOwner -eq $app.Id } | ConvertTo-Json -Compress
