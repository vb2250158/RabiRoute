param([string]$Executable, [int]$WorkBuddyPid, [switch]$Minimize)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WorkBuddyDesktopWindow {
    private delegate bool EnumWindow(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr state);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder value, int max);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int mode);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    public static IntPtr FindMainWindow(uint pid) {
        IntPtr match = IntPtr.Zero;
        int count = 0;
        EnumWindows((window, state) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != pid || GetWindow(window, 4) != IntPtr.Zero) return true;
            var name = new StringBuilder(64);
            var title = new StringBuilder(64);
            GetClassName(window, name, name.Capacity);
            GetWindowText(window, title, title.Capacity);
            if (name.ToString() == "Chrome_WidgetWin_1" && title.ToString() == "WorkBuddy") {
                match = window;
                count++;
            }
            return true;
        }, IntPtr.Zero);
        return count == 1 ? match : IntPtr.Zero;
    }
}
'@
if (-not $WorkBuddyPid) {
    $running = @(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $Executable -and ($_.MainWindowHandle -ne 0 -or
            [WorkBuddyDesktopWindow]::FindMainWindow($_.Id) -ne [IntPtr]::Zero)
    })
    if ($running.Count) { throw 'Exit the current WorkBuddy desktop before starting the desktop connector.' }
    exit 0
}
$app = Get-Process -Id $WorkBuddyPid
if ($app.Path -ne $Executable) { throw 'WorkBuddy main window is not ready.' }
$window = $app.MainWindowHandle
if ($window -eq 0) { $window = [WorkBuddyDesktopWindow]::FindMainWindow($WorkBuddyPid) }
if ($window -eq 0) { throw 'WorkBuddy main window is not ready.' }
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
