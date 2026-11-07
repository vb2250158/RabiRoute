using System.Text.Json;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using RabiRoute.WindowsBootstrap;

internal static class StartupPresentationTests
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        check(StartupPresentation.IsForegroundLaunch(Array.Empty<string>()), "plain user launch may show the native startup surface");
        foreach (var args in new[] { new[] { "--elevated-task" }, new[] { "--self-test" },
                     new[] { "--command", "status" }, new[] { "--command", "activate" }, new[] { "--register-elevated-host", "fixture" } })
            check(!StartupPresentation.IsForegroundLaunch(args), "commands and background elevated task never create a startup window");

        foreach (var finalState in new[] { "healthy", "degraded" })
        {
            var surface = new Surface(); var probes = 0;
            var replies = new Queue<ReadOnlyHostStatusResult>(new[] {
                new ReadOnlyHostStatusResult(true, "{\"state\":\"stopped\"}", ReceivedResponse: false),
                Status("starting"), Status(finalState) });
            await using var presentation = new StartupPresentation(surface,
                _ => { probes++; return Task.FromResult(replies.Dequeue()); }, (_, _) => Task.CompletedTask);
            await presentation.WaitForHandoffAsync();
            check(surface.Closed.IsCompleted && probes == 3, "real Host healthy/degraded closes immediately without a minimum animation duration");
            check(surface.Displays.Count == 2 && surface.Displays.All(item => !item.IsError), "disconnected status is not mistaken for completion or failure");
        }

        {
            var surface = new Surface(); var probes = 0;
            await using var presentation = new StartupPresentation(surface,
                _ => { probes++; return Task.FromResult(Status("healthy")); }, (_, _) => Task.CompletedTask);
            await presentation.FollowActivationAsync(2);
            check(probes == 1 && surface.Closed.IsCompleted, "second launch follows an already-starting Host instead of treating no-surface activation as startup failure");
        }

        {
            var surface = new Surface { CloseOnError = true }; var probes = 0;
            await using var presentation = new StartupPresentation(surface,
                _ => { probes++; return Task.FromResult(Status("faulted")); }, (_, _) => Task.CompletedTask);
            await presentation.WaitForHandoffAsync();
            check(surface.Displays.Single().IsError && probes == 1, "actual faulted Host is shown as an error, not READY or a retry request");
        }

        {
            var surface = new Surface(); var entered = new TaskCompletionSource(); CancellationToken observed = default;
            await using var presentation = new StartupPresentation(surface, async token => {
                observed = token; entered.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, token); return Status("healthy");
            });
            var handoff = presentation.WaitForHandoffAsync(); await entered.Task;
            surface.Close(); await handoff;
            check(observed.IsCancellationRequested, "closing the window cancels only the native read observer, not Host startup");
        }

        {
            var surface = new Surface(); var probes = 0;
            await using var presentation = new StartupPresentation(surface,
                _ => { probes++; return Task.FromResult(Status("starting")); });
            var failure = presentation.ShowFailureAsync("Selected release is unavailable.");
            check(!failure.IsCompleted && surface.Displays.Single().IsError, "actual bootstrap failure remains visible until dismissal");
            surface.Close(); await failure;
            check(probes == 0, "showing a bootstrap failure does not start a Host or query business APIs");
        }

        var root = Path.Combine(Path.GetTempPath(), "rabiroute-startup-theme-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "data", "desktop"));
        var file = Path.Combine(root, "data", "desktop", "startup-theme.json");
        try
        {
            var defaults = StartupTheme.Load(root);
            File.WriteAllText(file, "{bad");
            check(StartupTheme.Load(root) == defaults && File.ReadAllText(file) == "{bad", "bad optional theme keeps default presentation and original bytes");
            var palette = new { background = "#010203", foreground = "#040506", accent = "#070809" };
            var themeJson = JsonSerializer.Serialize(new { schemaVersion = 1, themeId = "fixture", light = palette, dark = palette, motion = "none", logoPath = Path.Combine(root, "fixture.ico") });
            File.WriteAllText(file, themeJson);
            var selected = StartupTheme.Load(root);
            check(selected.Background == 0x010203 && selected.Foreground == 0x040506 && selected.Accent == 0x070809
                && selected.Motion == "none", "native surface consumes the selected static theme without Manager or Qt");
            check(File.ReadAllText(file) == themeJson, "theme projection is read-only to the bootstrap");
            File.WriteAllText(file, "{\"schemaVersion\":999}");
            check(StartupTheme.Load(root) == defaults, "future optional presentation schema does not block Host startup");
            foreach (var malformedSchema in new[] { "\"1\"", "null", "{}" })
            {
                File.WriteAllText(file, "{\"schemaVersion\":" + malformedSchema + "}");
                check(StartupTheme.Load(root) == defaults, "invalid optional schema type cannot become a bootstrap error");
            }
            File.WriteAllText(file, JsonSerializer.Serialize(new { schemaVersion = 1, themeId = "dark",
                light = palette, dark = new { background = "#111213", foreground = "#f1f2f3", accent = "#212223" },
                frames = new object[] { new { logoPath = "fixture.ico", durationMs = 4294967296L }, new { durationMs = -1 }, "bad" } }));
            selected = StartupTheme.Load(root);
            check(selected.Background == 0x111213 && selected.Foreground == 0xf1f2f3, "explicit dark theme overrides OS palette selection");
            check(selected.Frames is [{ DurationMs: 4294967296L }], "custom frames preserve long durations and isolate malformed neighbors without a frame-count limit");
        }
        finally { Directory.Delete(root, recursive: true); }

        var firstFrame = System.Diagnostics.Stopwatch.StartNew();
        using (var window = new StartupWindow())
        {
            await window.Ready;
            Console.WriteLine($"Native startup first frame: {firstFrame.Elapsed.TotalMilliseconds:0.0} ms; current fixture PID {Environment.ProcessId}; no child Host/Manager.");
            check(!window.Closed.IsCompleted, "real Win32 window completed its first paint in the current test process");
            window.Close(); await window.Closed;
            check(window.Closed.IsCompleted, "native surface closes its own window and releases the UI thread without starting a Host");
        }

        var iconFile = BrandIcon(); var decodes = 0;
        using (var frames = StartupWindow.IconFrames.Load(new[] { new StartupIconFrame(iconFile, 100), new StartupIconFrame(iconFile, 400) },
            CancellationToken.None, decoder: file => { decodes++; return LoadImage(IntPtr.Zero, file, 1, 56, 56, 0x0010); }))
        {
            check(frames is not null && decodes == 1, "repeated ICO frames decode once and retain ordered independent durations");
            check(frames!.At(0) == frames.At(150) && frames.NextDelay(0) == 100 && frames.NextDelay(100) == 400
                && frames.NextDelay(499) == 1 && frames.NextDelay(500) == 100, "frame sequence timing wraps using the original per-frame durations");
        }
        using (var still = StartupWindow.IconFrames.Load(new[] { new StartupIconFrame(iconFile, 4294967296L), new StartupIconFrame("missing.ico", 10) }, CancellationToken.None, firstOnly: true))
            check(still is not null && still.NextDelay(0) == int.MaxValue, "reduced-motion first frame remains visible and long duration uses timer chunks, not a duration cap");

        using (var release = new ManualResetEventSlim())
        {
            var entered = new TaskCompletionSource(); var dismissed = new TaskCompletionSource(); IntPtr lateIcon = IntPtr.Zero;
            var theme = StartupTheme.Default with { Frames = new[] { new StartupIconFrame(iconFile, 100) } };
            using var window = new StartupWindow(theme, file => {
                entered.TrySetResult(); release.Wait();
                lateIcon = LoadImage(IntPtr.Zero, file, 1, 56, 56, 0x0010); return lateIcon;
            });
            window.Dismissed += () => dismissed.TrySetResult();
            try
            {
                await window.Ready; await entered.Task;
                check(!window.Closed.IsCompleted, "first native frame paints while its owned custom-frame decoder is still pending");
                window.Close(); await dismissed.Task;
                check(!window.Closed.IsCompleted, "closed window joins its in-flight icon owner before reporting resource completion");
            }
            finally { release.Set(); }
            await window.Closed;
            check(lateIcon != IntPtr.Zero && !IsLiveIcon(lateIcon), "an icon returned after dismissal is really destroyed before the owner closes");
        }
    }

    private static string BrandIcon([CallerFilePath] string source = "") => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "../../../assets/rabiroute-icon.ico"));
    private static bool IsLiveIcon(IntPtr icon)
    {
        if (!GetIconInfo(icon, out var info)) return false;
        if (info.Mask != IntPtr.Zero) DeleteObject(info.Mask);
        if (info.Color != IntPtr.Zero) DeleteObject(info.Color);
        return true;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IconInfo { internal int Icon; internal uint X, Y; internal IntPtr Mask, Color; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);

    private static ReadOnlyHostStatusResult Status(string state) => new(true, JsonSerializer.Serialize(new { ok = true, state }));

    private sealed class Surface : IStartupWindow
    {
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly List<StartupDisplay> Displays = new();
        internal bool CloseOnError;
        public Task Ready => Task.CompletedTask;
        public Task Closed => _closed.Task;
        public event Action? Dismissed;
        public void Present(StartupDisplay display)
        {
            Displays.Add(display);
            if (display.IsError && CloseOnError) Close();
        }
        public void ApplyTheme(StartupTheme theme) { }
        public void Close() { if (_closed.TrySetResult()) Dismissed?.Invoke(); }
        public void Dispose() => Close();
    }
}
