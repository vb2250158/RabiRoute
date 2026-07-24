[CmdletBinding()]
param(
    [ValidateRange(1, 1000)]
    [int]$Samples = 100,

    [ValidateRange(0, 5000)]
    [int]$PauseMilliseconds = 250,

    [ValidateRange(1, 5000)]
    [double]$ThresholdMilliseconds = 100,

    [int]$TrayProcessId = 0,

    [ValidateSet("both", "left", "right")]
    [string]$Activation = "both",

    [switch]$ShowSamples
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
    throw "Tray latency measurement is only available on Windows."
}

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class RabiRouteTrayLatencyProbe : IDisposable
{
    private const uint CallbackMessage = 0x8065;
    private const uint EventObjectShow = 0x8002;
    private const uint LeftSelect = 0x0400;
    private const uint RightContext = 0x007B;
    private const uint KeyDown = 0x0100;
    private const uint KeyUp = 0x0101;
    private const uint EscapeKey = 0x001B;
    private const uint WinEventOutOfContext = 0;
    private const uint WinEventSkipOwnProcess = 2;
    private const uint WindowClose = 0x0010;

    private readonly AutoResetEvent menuShown = new AutoResetEvent(false);
    private readonly WinEventDelegate eventCallback;
    private readonly uint processId;
    private readonly IntPtr trayWindow;
    private IntPtr eventHook;
    private uint startedEventTime;
    private uint shownEventTime;
    private long startedTimestamp;
    private long shownTimestamp;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
    private delegate void WinEventDelegate(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(
        uint eventMin,
        uint eventMax,
        IntPtr eventHookModule,
        WinEventDelegate callback,
        uint processId,
        uint threadId,
        uint flags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hook);

    public RabiRouteTrayLatencyProbe(int requestedProcessId)
    {
        trayWindow = FindTrayWindow(requestedProcessId, out processId);
        if (trayWindow == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                "No RabiRoute-Tray Qt tray message window was found. Start the packaged tray first.");
        }

        eventCallback = OnWinEvent;
        eventHook = SetWinEventHook(
            EventObjectShow,
            EventObjectShow,
            IntPtr.Zero,
            eventCallback,
            processId,
            0,
            WinEventOutOfContext | WinEventSkipOwnProcess);
        if (eventHook == IntPtr.Zero)
        {
            throw new InvalidOperationException("SetWinEventHook(EVENT_OBJECT_SHOW) failed.");
        }
    }

    public int ProcessId
    {
        get { return checked((int)processId); }
    }

    public double[] Measure(string activation, int sampleCount, int pauseMilliseconds)
    {
        uint activationCode;
        if (String.Equals(activation, "left", StringComparison.OrdinalIgnoreCase))
        {
            activationCode = LeftSelect;
        }
        else if (String.Equals(activation, "right", StringComparison.OrdinalIgnoreCase))
        {
            activationCode = RightContext;
        }
        else
        {
            throw new ArgumentException("Activation must be 'left' or 'right'.", "activation");
        }

        var samples = new double[sampleCount];
        for (var index = 0; index < sampleCount; index++)
        {
            CloseVisibleMenus();
            if (pauseMilliseconds > 0)
            {
                Thread.Sleep(pauseMilliseconds);
            }

            menuShown.Reset();
            shownEventTime = 0;
            shownTimestamp = 0;
            var wParam = activationCode == RightContext ? CurrentCursorPosition() : UIntPtr.Zero;
            startedEventTime = GetTickCount();
            startedTimestamp = Stopwatch.GetTimestamp();
            if (!PostMessage(trayWindow, CallbackMessage, wParam, (IntPtr)activationCode))
            {
                throw new InvalidOperationException("PostMessage to the Qt tray window failed.");
            }

            if (!menuShown.WaitOne(1500))
            {
                samples[index] = 1500;
                continue;
            }

            samples[index] = shownEventTime != 0
                ? unchecked((uint)(shownEventTime - startedEventTime))
                : (shownTimestamp - startedTimestamp) * 1000.0 / Stopwatch.Frequency;
        }

        CloseVisibleMenus();
        return samples;
    }

    public void Dispose()
    {
        CloseVisibleMenus();
        if (eventHook != IntPtr.Zero)
        {
            UnhookWinEvent(eventHook);
            eventHook = IntPtr.Zero;
        }
        menuShown.Dispose();
        GC.KeepAlive(eventCallback);
    }

    private static IntPtr FindTrayWindow(int requestedProcessId, out uint foundProcessId)
    {
        var candidates = new List<Tuple<IntPtr, uint, DateTime>>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            var className = WindowClass(window);
            if (!className.EndsWith("TrayIconMessageWindowClass", StringComparison.Ordinal))
            {
                return true;
            }
            if (!String.Equals(WindowTitle(window), "QTrayIconMessageWindow", StringComparison.Ordinal))
            {
                return true;
            }

            uint candidateProcessId;
            GetWindowThreadProcessId(window, out candidateProcessId);
            if (requestedProcessId > 0 && candidateProcessId != (uint)requestedProcessId)
            {
                return true;
            }

            try
            {
                var process = Process.GetProcessById(checked((int)candidateProcessId));
                if (!String.Equals(process.ProcessName, "RabiRoute-Tray", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                candidates.Add(Tuple.Create(window, candidateProcessId, process.StartTime));
            }
            catch (ArgumentException)
            {
                // The process exited while windows were being enumerated.
            }
            return true;
        }, IntPtr.Zero);

        var selected = candidates.OrderBy(candidate => candidate.Item3).LastOrDefault();
        if (selected == null)
        {
            foundProcessId = 0;
            return IntPtr.Zero;
        }
        foundProcessId = selected.Item2;
        return selected.Item1;
    }

    private void OnWinEvent(
        IntPtr hook,
        uint eventType,
        IntPtr window,
        int objectId,
        int childId,
        uint eventThread,
        uint eventTime)
    {
        if (window == IntPtr.Zero || !WindowClass(window).Contains("QWindowPopup"))
        {
            return;
        }

        uint eventProcessId;
        GetWindowThreadProcessId(window, out eventProcessId);
        if (eventProcessId != processId)
        {
            return;
        }

        shownEventTime = eventTime;
        shownTimestamp = Stopwatch.GetTimestamp();
        menuShown.Set();
    }

    private void CloseVisibleMenus()
    {
        var menus = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            uint windowProcessId;
            GetWindowThreadProcessId(window, out windowProcessId);
            if (windowProcessId == processId
                && IsWindowVisible(window)
                && WindowClass(window).Contains("QWindowPopup"))
            {
                menus.Add(window);
            }
            return true;
        }, IntPtr.Zero);

        foreach (var menu in menus)
        {
            PostMessage(menu, KeyDown, (UIntPtr)EscapeKey, IntPtr.Zero);
            PostMessage(menu, KeyUp, (UIntPtr)EscapeKey, IntPtr.Zero);
        }

        var deadline = Stopwatch.StartNew();
        while (menus.Any(IsWindowVisible) && deadline.ElapsedMilliseconds < 500)
        {
            Thread.Sleep(1);
        }
        foreach (var menu in menus.Where(IsWindowVisible))
        {
            PostMessage(menu, WindowClose, UIntPtr.Zero, IntPtr.Zero);
        }
    }

    private static UIntPtr CurrentCursorPosition()
    {
        Point point;
        if (!GetCursorPos(out point))
        {
            return UIntPtr.Zero;
        }
        var packed = (uint)((point.X & 0xFFFF) | ((point.Y & 0xFFFF) << 16));
        return (UIntPtr)packed;
    }

    private static string WindowClass(IntPtr window)
    {
        var value = new StringBuilder(128);
        GetClassName(window, value, value.Capacity);
        return value.ToString();
    }

    private static string WindowTitle(IntPtr window)
    {
        var value = new StringBuilder(256);
        GetWindowText(window, value, value.Capacity);
        return value.ToString();
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

function Get-NearestRankPercentile {
    param(
        [double[]]$Values,
        [double]$Percentile
    )

    $sorted = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($sorted.Count * $Percentile) - 1)
    return [double]$sorted[$index]
}

$probe = [RabiRouteTrayLatencyProbe]::new($TrayProcessId)
try {
    $activations = if ($Activation -eq "both") { @("left", "right") } else { @($Activation) }
    $summaries = foreach ($activationKind in $activations) {
        $values = $probe.Measure($activationKind, $Samples, $PauseMilliseconds)
        if ($ShowSamples) {
            for ($index = 0; $index -lt $values.Count; $index++) {
                Write-Host ("{0}[{1}]={2:N3}ms" -f $activationKind, ($index + 1), $values[$index])
            }
        }

        $sorted = @($values | Sort-Object)
        $p95 = Get-NearestRankPercentile -Values $values -Percentile 0.95
        $maximum = [double]$sorted[-1]
        [pscustomobject]@{
            Activation = $activationKind
            Samples = $values.Count
            MinimumMs = [Math]::Round([double]$sorted[0], 3)
            MedianMs = [Math]::Round((Get-NearestRankPercentile -Values $values -Percentile 0.5), 3)
            P95Ms = [Math]::Round($p95, 3)
            MaximumMs = [Math]::Round($maximum, 3)
            ThresholdMs = $ThresholdMilliseconds
            Passed = $p95 -le $ThresholdMilliseconds -and $maximum -le $ThresholdMilliseconds
        }
    }

    "RabiRoute tray PID: $($probe.ProcessId)"
    $summaries | Format-Table -AutoSize
    if ($summaries.Passed -contains $false) {
        throw "Tray menu latency exceeded ${ThresholdMilliseconds}ms."
    }
}
finally {
    $probe.Dispose()
}
