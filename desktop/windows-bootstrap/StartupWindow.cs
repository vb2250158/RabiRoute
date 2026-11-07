using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

namespace RabiRoute.WindowsBootstrap;

/** Optional derived theme; neither its absence nor its resources affect Host readiness. */
internal sealed record StartupIconFrame(string LogoPath, long DurationMs);

internal sealed record StartupTheme(uint Background, uint Foreground, uint Accent,
    string Motion = "orbit", string? LogoPath = null, IReadOnlyList<StartupIconFrame>? Frames = null)
{
    internal static StartupTheme Default => new(0xf6f8fb, 0x112033, 0x19bfc1);

    internal static StartupTheme Load(string stateRoot)
    {
        var dark = false;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            dark = key?.GetValue("AppsUseLightTheme") is int value && value == 0;
        }
        catch (Exception error) when (error is UnauthorizedAccessException or System.Security.SecurityException or IOException) { }
        var defaults = dark ? new StartupTheme(0x121a22, 0xe9f2f7, 0x43d4d7) : Default;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(stateRoot, "data", "desktop", "startup-theme.json")));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("schemaVersion", out var schema)
                || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version) || version != 1) return defaults;
            if (root.TryGetProperty("themeId", out var themeId) && themeId.ValueKind == JsonValueKind.String)
            {
                if (themeId.GetString() == "light") dark = false;
                if (themeId.GetString() == "dark") dark = true;
                defaults = dark ? new StartupTheme(0x121a22, 0xe9f2f7, 0x43d4d7) : Default;
            }
            var palette = root.TryGetProperty(dark ? "dark" : "light", out var selected) && selected.ValueKind == JsonValueKind.Object
                ? selected : default;
            uint Color(string name, uint fallback) => palette.ValueKind == JsonValueKind.Object
                && palette.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String
                && field.GetString() is { Length: 7 } text && text[0] == '#'
                && uint.TryParse(text.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var color)
                    ? color : fallback;
            var motion = root.TryGetProperty("motion", out var mode) && mode.ValueKind == JsonValueKind.String ? mode.GetString() : null;
            var logo = root.TryGetProperty("logoPath", out var resource) && resource.ValueKind == JsonValueKind.String ? resource.GetString() : null;
            List<StartupIconFrame>? frames = null;
            if (root.TryGetProperty("frames", out var sequence) && sequence.ValueKind == JsonValueKind.Array)
            {
                frames = new();
                foreach (var frame in sequence.EnumerateArray())
                    if (frame.ValueKind == JsonValueKind.Object
                        && frame.TryGetProperty("logoPath", out var image) && image.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(image.GetString())
                        && frame.TryGetProperty("durationMs", out var duration) && duration.ValueKind == JsonValueKind.Number
                        && duration.TryGetInt64(out var milliseconds) && milliseconds > 0)
                        frames.Add(new StartupIconFrame(image.GetString()!, milliseconds));
            }
            return new(Color("background", defaults.Background), Color("foreground", defaults.Foreground),
                Color("accent", defaults.Accent), motion is "none" or "breathe" or "orbit" ? motion : defaults.Motion, logo, frames);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return defaults;
        }
    }
}

/** A small window in the original launcher process; no Python, browser, or extra process. */
internal sealed class StartupWindow : IStartupWindow
{
    private const uint UpdateMessage = 0x8001;
    private const uint FramesLoadedMessage = 0x8002;
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly WindowProcedure _procedure;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly object _presentationLock = new();
    private StartupDisplay _display = new("正在检查 RabiRoute 启动环境…");
    private StartupTheme _theme = StartupTheme.Default;
    private StartupTheme? _appliedTheme;
    private IntPtr _handle, _button, _icon, _titleFont, _bodyFont;
    private bool _ownsIcon;
    private int _scale = 100;
    private readonly object _frameOwnership = new();
    private readonly List<Task> _frameLoads = new();
    private readonly List<CancellationTokenSource> _frameLifetimes = new();
    private CancellationTokenSource? _currentFrameLifetime;
    private IconFrames? _frames, _pendingFrames;
    private long _frameVersion, _framesStartedAt;
    private bool _closing, _reducedMotion;
    private readonly Func<string, IntPtr> _decodeFrame;

    internal StartupWindow(StartupTheme? theme = null, Func<string, IntPtr>? frameDecoder = null)
    {
        _theme = theme ?? StartupTheme.Default;
        _decodeFrame = frameDecoder ?? (file => LoadImage(IntPtr.Zero, file, 1, 56, 56, 0x0010));
        _procedure = Dispatch;
        var thread = new Thread(Run) { IsBackground = true, Name = "RabiRoute startup window" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    public Task Ready => _ready.Task;
    public Task Closed => _closed.Task;
    public event Action? Dismissed;

    public void Present(StartupDisplay display)
    {
        lock (_presentationLock) _display = display;
        if (_handle != IntPtr.Zero) PostMessage(_handle, UpdateMessage, UIntPtr.Zero, IntPtr.Zero);
    }

    public void ApplyTheme(StartupTheme theme)
    {
        lock (_presentationLock) _theme = theme;
        if (_handle != IntPtr.Zero) PostMessage(_handle, UpdateMessage, UIntPtr.Zero, IntPtr.Zero);
    }

    public void Close()
    {
        if (_handle != IntPtr.Zero) PostMessage(_handle, 0x0010, UIntPtr.Zero, IntPtr.Zero);
    }

    public void Dispose() => Close();
    private int S(int value) => value * _scale / 100;
    private static uint ColorRef(uint rgb) => (rgb >> 16) | (rgb & 0x00ff00) | ((rgb & 0xff) << 16);

    private void Run()
    {
        var instance = GetModuleHandle(null);
        var className = "RabiRoute.Startup." + Guid.NewGuid().ToString("N");
        ushort registered = 0;
        try
        {
            if (SystemParametersInfo(0x1042, 0, out var animations, 0)) _reducedMotion = animations == 0;
            _scale = checked((int)GetDpiForSystem() * 100 / 96);
            var type = new WindowClass
            {
                Size = (uint)Marshal.SizeOf<WindowClass>(), Procedure = Marshal.GetFunctionPointerForDelegate(_procedure),
                Instance = instance, ClassName = className, Cursor = LoadCursor(IntPtr.Zero, new IntPtr(32512))
            };
            registered = RegisterClassEx(ref type);
            if (registered == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            _handle = CreateWindowEx(0, className, "RabiRoute", 0x02c80000,
                int.MinValue, int.MinValue, S(480), S(235), IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (_handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            _titleFont = CreateFont(-S(22), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
            _bodyFont = CreateFont(-S(14), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
            _button = CreateWindowEx(0, "BUTTON", "后台继续", 0x5001000b,
                S(340), S(150), S(105), S(30), _handle, new IntPtr(1), instance, IntPtr.Zero);
            SendMessage(_button, 0x0030, _bodyFont, new IntPtr(1));
            ApplyNativeTheme();
            ShowWindow(_handle, 1);
            SetFocus(_button);
            UpdateWindow(_handle);
            while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
            {
                if (!IsDialogMessage(_handle, ref message))
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
        }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException)
        {
            _ready.TrySetException(error);
        }
        finally
        {
            lock (_frameOwnership)
            {
                _closing = true;
                _frameVersion++;
                _pendingFrames?.Dispose(); _pendingFrames = null;
            }
            foreach (var lifetime in _frameLifetimes) lifetime.Cancel();
            _frames?.Dispose(); _frames = null;
            if (_handle != IntPtr.Zero && IsWindow(_handle)) DestroyWindow(_handle);
            _handle = IntPtr.Zero;
            if (_ownsIcon && _icon != IntPtr.Zero) DestroyIcon(_icon);
            if (_titleFont != IntPtr.Zero) DeleteObject(_titleFont);
            if (_bodyFont != IntPtr.Zero) DeleteObject(_bodyFont);
            if (registered != 0) UnregisterClass(className, instance);
            _ready.TrySetException(new InvalidOperationException("Startup window closed before its first frame."));
            Dismissed?.Invoke();
            _ = CompleteResourceReleaseAsync();
        }
    }

    private async Task CompleteResourceReleaseAsync()
    {
        await Task.WhenAll(_frameLoads);
        foreach (var lifetime in _frameLifetimes) lifetime.Dispose();
        _closed.TrySetResult();
    }

    private void ApplyNativeTheme()
    {
        StartupTheme theme;
        lock (_presentationLock) theme = _theme;
        if (theme == _appliedTheme) return;
        _appliedTheme = theme;
        _currentFrameLifetime?.Cancel();
        _frames?.Dispose(); _frames = null;
        lock (_frameOwnership) { _frameVersion++; _pendingFrames?.Dispose(); _pendingFrames = null; }
        if (_ownsIcon && _icon != IntPtr.Zero) DestroyIcon(_icon);
        _icon = string.IsNullOrWhiteSpace(theme.LogoPath) ? IntPtr.Zero
            : LoadImage(IntPtr.Zero, theme.LogoPath, 1, S(56), S(56), 0x0010);
        _ownsIcon = _icon != IntPtr.Zero;
        var decodedLogo = _ownsIcon ? theme.LogoPath : null;
        if (_icon == IntPtr.Zero && Environment.ProcessPath is { } executable)
        {
            var icons = new IntPtr[1];
            if (ExtractIconEx(executable, 0, icons, null, 1) > 0) { _icon = icons[0]; _ownsIcon = true; }
        }
        if (_icon == IntPtr.Zero) _icon = LoadIcon(IntPtr.Zero, new IntPtr(32512));
        SendMessage(_handle, 0x0080, new IntPtr(1), _icon);
        var darkCaption = ((theme.Background >> 16) + ((theme.Background >> 8) & 255) + (theme.Background & 255)) < 384 ? 1 : 0;
        _ = DwmSetWindowAttribute(_handle, 20, ref darkCaption, sizeof(int));
        ScheduleAnimation();
        if (theme.Frames is { Count: > 0 })
        {
            var lifetime = new CancellationTokenSource();
            _currentFrameLifetime = lifetime; _frameLifetimes.Add(lifetime);
            var version = _frameVersion;
            var baseIcon = _icon;
            _frameLoads.Add(Task.Run(() =>
            {
                var loaded = IconFrames.Load(theme.Frames, lifetime.Token, _reducedMotion || theme.Motion == "none", decodedLogo, baseIcon, _decodeFrame);
                lock (_frameOwnership)
                {
                    if (_closing || lifetime.IsCancellationRequested || version != _frameVersion) { loaded?.Dispose(); return; }
                    _pendingFrames?.Dispose(); _pendingFrames = loaded;
                    PostMessage(_handle, FramesLoadedMessage, UIntPtr.Zero, IntPtr.Zero);
                }
            }));
        }
    }

    private void ScheduleAnimation()
    {
        StartupDisplay display; lock (_presentationLock) display = _display;
        if (_reducedMotion || display.IsError || _appliedTheme?.Motion == "none")
        {
            KillTimer(_handle, new UIntPtr(1)); return;
        }
        var interval = _frames?.NextDelay(_clock.ElapsedMilliseconds - _framesStartedAt) ?? 80;
        if (_appliedTheme?.Motion != "none") interval = Math.Min(interval, 80);
        SetTimer(_handle, new UIntPtr(1), (uint)interval, IntPtr.Zero);
    }

    private IntPtr Dispatch(IntPtr window, uint message, UIntPtr word, IntPtr value)
    {
        if (message == 0x0010 || (message == 0x0111 && (word.ToUInt64() & 0xffff) == 1))
        {
            DestroyWindow(window); // Only dismiss this presentation; never terminate the Host.
            return IntPtr.Zero;
        }
        if (message == 0x0002)
        {
            KillTimer(window, new UIntPtr(1)); PostQuitMessage(0); return IntPtr.Zero;
        }
        if (message == 0x0014) return new IntPtr(1);
        if (message == 0x002b && word.ToUInt64() == 1)
        {
            DrawButton(Marshal.PtrToStructure<DrawItemData>(value)); return new IntPtr(1);
        }
        if (message == UpdateMessage)
        {
            ApplyNativeTheme();
            StartupDisplay display; lock (_presentationLock) display = _display;
            if (display.IsError)
            {
                _currentFrameLifetime?.Cancel();
                lock (_frameOwnership) { _frameVersion++; _pendingFrames?.Dispose(); _pendingFrames = null; }
                _frames?.Dispose(); _frames = null;
            }
            ScheduleAnimation();
            SetWindowText(_button, display.IsError ? "关闭" : "后台继续");
            InvalidateRect(window, IntPtr.Zero, false); return IntPtr.Zero;
        }
        if (message == 0x0005)
        {
            if (word.ToUInt64() == 1) KillTimer(window, new UIntPtr(1));
            else ScheduleAnimation();
        }
        if (message == FramesLoadedMessage)
        {
            lock (_frameOwnership)
            {
                if (_pendingFrames is null) return IntPtr.Zero;
                _frames?.Dispose(); _frames = _pendingFrames; _pendingFrames = null;
            }
            _framesStartedAt = _clock.ElapsedMilliseconds;
            ScheduleAnimation(); InvalidateRect(window, IntPtr.Zero, false); return IntPtr.Zero;
        }
        if (message == 0x0113) { ScheduleAnimation(); InvalidateRect(window, IntPtr.Zero, false); return IntPtr.Zero; }
        if (message == 0x000f) { Paint(window); return IntPtr.Zero; }
        if (message == 0x0318) { PaintContent(window, new IntPtr(unchecked((long)word.ToUInt64()))); return IntPtr.Zero; }
        return DefWindowProc(window, message, word, value);
    }

    private void Paint(IntPtr window)
    {
        var dc = BeginPaint(window, out var paint);
        try { PaintContent(window, dc); }
        finally { EndPaint(window, ref paint); }
        _ready.TrySetResult();
    }

    private void PaintContent(IntPtr window, IntPtr dc)
    {
        StartupDisplay display; StartupTheme theme;
        lock (_presentationLock) { display = _display; theme = _theme; }
            GetClientRect(window, out var bounds);
            var background = CreateSolidBrush(ColorRef(theme.Background));
            FillRect(dc, ref bounds, background); DeleteObject(background);
            SetBkMode(dc, 1); SetTextColor(dc, ColorRef(theme.Foreground));
            SelectObject(dc, _titleFont);
            var title = new Rectangle(S(116), S(25), S(445), S(58));
            DrawText(dc, "RabiRoute", -1, ref title, 0x0800);
            SelectObject(dc, _bodyFont);
            var text = new Rectangle(S(116), S(64), S(445), S(132));
            DrawText(dc, display.Message, -1, ref text, 0x0810);
            var hint = new Rectangle(S(24), S(155), S(330), S(190));
            DrawText(dc, display.IsError ? "关闭此提示不会修改服务状态。" : "关闭窗口后将继续在后台启动。", -1, ref hint, 0x0810);
            var still = _reducedMotion || theme.Motion == "none";
            var currentIcon = _frames?.At(still ? 0 : _clock.ElapsedMilliseconds - _framesStartedAt) ?? _icon;
            if (currentIcon != IntPtr.Zero) DrawIconEx(dc, S(34), S(46), currentIcon, S(48), S(48), 0, IntPtr.Zero, 3);
            var accent = display.IsError ? 0xdc2626u : theme.Accent;
            var width = !still && theme.Motion == "breathe" ? 2 + (int)(1 + Math.Sin(_clock.Elapsed.TotalSeconds * 3)) : 3;
            var pen = CreatePen(0, S(width), ColorRef(accent));
            var oldPen = SelectObject(dc, pen);
            var oldBrush = SelectObject(dc, GetStockObject(5));
            var angle = !_reducedMotion && theme.Motion == "orbit" ? _clock.Elapsed.TotalSeconds * 2 : 0;
            int X(double a) => S(58 + (int)(36 * Math.Cos(a)));
            int Y(double a) => S(70 + (int)(36 * Math.Sin(a)));
            Arc(dc, S(22), S(34), S(94), S(106), X(angle), Y(angle), X(angle + 4), Y(angle + 4));
            SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen);
    }

    internal sealed class IconFrames : IDisposable
    {
        private readonly (IntPtr Icon, double End)[] _sequence;
        private readonly IntPtr[] _owned;
        private int _disposed;
        private IconFrames(List<(IntPtr Icon, double End)> sequence, IEnumerable<IntPtr> owned)
        { _sequence = sequence.ToArray(); _owned = owned.ToArray(); }

        internal static IconFrames? Load(IReadOnlyList<StartupIconFrame> frames, CancellationToken token,
            bool firstOnly = false, string? borrowedPath = null, IntPtr borrowedIcon = default,
            Func<string, IntPtr>? decoder = null)
        {
            var icons = new Dictionary<string, IntPtr>(StringComparer.OrdinalIgnoreCase);
            var owned = new List<IntPtr>(); var sequence = new List<(IntPtr, double)>(); double end = 0;
            var transferred = false;
            if (borrowedPath is not null && borrowedIcon != IntPtr.Zero) icons.Add(borrowedPath, borrowedIcon);
            try
            {
                foreach (var frame in frames)
                {
                    token.ThrowIfCancellationRequested();
                    if (!icons.TryGetValue(frame.LogoPath, out var icon))
                    {
                        try { icon = decoder is null ? LoadImage(IntPtr.Zero, frame.LogoPath, 1, 56, 56, 0x0010) : decoder(frame.LogoPath); }
                        catch (Exception error) when (error is IOException or UnauthorizedAccessException or Win32Exception or ArgumentException) { icon = IntPtr.Zero; }
                        icons.Add(frame.LogoPath, icon);
                        if (icon != IntPtr.Zero) owned.Add(icon);
                    }
                    if (icon == IntPtr.Zero) continue;
                    end += frame.DurationMs; sequence.Add((icon, end));
                    if (firstOnly) break;
                }
                token.ThrowIfCancellationRequested();
                if (sequence.Count == 0) return null;
                transferred = true;
                return new IconFrames(sequence, owned);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                return null;
            }
            finally { if (!transferred) foreach (var icon in owned) DestroyIcon(icon); }
        }

        private (int Index, double Position) Position(long elapsed)
        {
            var cycle = _sequence[^1].End;
            var position = double.IsFinite(cycle) ? elapsed % cycle : elapsed;
            var low = 0; var high = _sequence.Length - 1;
            while (low < high)
            {
                var middle = low + (high - low) / 2;
                if (position < _sequence[middle].End) high = middle; else low = middle + 1;
            }
            return (low, position);
        }
        internal IntPtr At(long elapsed) => _sequence[Position(elapsed).Index].Icon;
        internal int NextDelay(long elapsed)
        {
            var current = Position(elapsed);
            // Win32 timer chunks are not a limit on the frame's duration.
            return (int)Math.Min(int.MaxValue, Math.Max(1, _sequence[current.Index].End - current.Position));
        }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) foreach (var icon in _owned) DestroyIcon(icon);
        }
    }

    private void DrawButton(DrawItemData item)
    {
        StartupTheme theme; lock (_presentationLock) theme = _theme;
        var pressed = (item.State & 1) != 0;
        uint Blend(int shift)
        {
            var background = (theme.Background >> shift) & 255;
            var accent = (theme.Accent >> shift) & 255;
            return (background * (pressed ? 3u : 7u) + accent) / (pressed ? 4u : 8u);
        }
        var face = CreateSolidBrush(ColorRef((Blend(16) << 16) | (Blend(8) << 8) | Blend(0)));
        FillRect(item.Dc, ref item.Bounds, face); DeleteObject(face);
        var border = CreatePen(0, S(1), ColorRef(theme.Accent));
        var oldPen = SelectObject(item.Dc, border); var oldBrush = SelectObject(item.Dc, GetStockObject(5));
        RoundRect(item.Dc, item.Bounds.Left, item.Bounds.Top, item.Bounds.Right, item.Bounds.Bottom, S(8), S(8));
        SelectObject(item.Dc, oldPen); SelectObject(item.Dc, oldBrush); DeleteObject(border);
        SetBkMode(item.Dc, 1); SetTextColor(item.Dc, ColorRef(theme.Foreground));
        var oldFont = SelectObject(item.Dc, _bodyFont);
        var title = new System.Text.StringBuilder(80); GetWindowText(item.Window, title, title.Capacity);
        DrawText(item.Dc, title.ToString(), -1, ref item.Bounds, 0x0825);
        SelectObject(item.Dc, oldFont);
        if ((item.State & 0x0010) != 0)
        {
            var focus = new Rectangle(item.Bounds.Left + S(4), item.Bounds.Top + S(4), item.Bounds.Right - S(4), item.Bounds.Bottom - S(4));
            DrawFocusRect(item.Dc, ref focus);
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)] private delegate IntPtr WindowProcedure(IntPtr window, uint message, UIntPtr word, IntPtr value);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass
    {
        internal uint Size, Style; internal IntPtr Procedure; internal int ClassExtra, WindowExtra;
        internal IntPtr Instance, Icon, Cursor, Background; internal string? MenuName, ClassName; internal IntPtr SmallIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Rectangle
    {
        internal int Left, Top, Right, Bottom;
        internal Rectangle(int left, int top, int right, int bottom) { Left = left; Top = top; Right = right; Bottom = bottom; }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Message
    {
        internal IntPtr Window; internal uint Id; internal UIntPtr Word; internal IntPtr Value;
        internal uint Time; internal int X, Y; internal uint Private;
    }
    [StructLayout(LayoutKind.Sequential)] private struct PaintData
    {
        internal IntPtr Dc; internal int Erase; internal Rectangle Bounds; internal int Restore, Incremental;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] internal byte[] Reserved;
    }
    [StructLayout(LayoutKind.Sequential)] private struct DrawItemData
    {
        internal uint Type, ControlId, ItemId, Action, State;
        internal IntPtr Window, Dc; internal Rectangle Bounds; internal UIntPtr ItemData;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string? name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClass value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClass(string name, IntPtr instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint extended, string type, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr window, uint message, UIntPtr word, IntPtr value);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool UpdateWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] private static extern bool SystemParametersInfo(uint action, uint parameter, out int value, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetMessage(out Message message, IntPtr window, uint minimum, uint maximum);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool IsDialogMessage(IntPtr window, ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessage(IntPtr window, uint message, UIntPtr word, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr word, IntPtr value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowText(IntPtr window, string text);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool DrawFocusRect(IntPtr dc, ref Rectangle rectangle);
    [DllImport("user32.dll")] private static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint interval, IntPtr callback);
    [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr window, UIntPtr id);
    [DllImport("user32.dll")] private static extern bool InvalidateRect(IntPtr window, IntPtr rectangle, bool erase);
    [DllImport("user32.dll")] private static extern IntPtr BeginPaint(IntPtr window, out PaintData data);
    [DllImport("user32.dll")] private static extern bool EndPaint(IntPtr window, ref PaintData data);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out Rectangle rectangle);
    [DllImport("user32.dll")] private static extern int FillRect(IntPtr dc, ref Rectangle rectangle, IntPtr brush);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int DrawText(IntPtr dc, string text, int count, ref Rectangle rectangle, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadCursor(IntPtr instance, IntPtr name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadIcon(IntPtr instance, IntPtr name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[]? small, uint count);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern IntPtr CreatePen(int style, int width, uint color);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] private static extern IntPtr GetStockObject(int index);
    [DllImport("gdi32.dll")] private static extern int SetBkMode(IntPtr dc, int mode);
    [DllImport("gdi32.dll")] private static extern uint SetTextColor(IntPtr dc, uint color);
    [DllImport("gdi32.dll")] private static extern bool Arc(IntPtr dc, int left, int top, int right, int bottom, int startX, int startY, int endX, int endY);
    [DllImport("gdi32.dll")] private static extern bool RoundRect(IntPtr dc, int left, int top, int right, int bottom, int ellipseWidth, int ellipseHeight);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateFont(int height, int width, int escapement, int orientation, int weight, uint italic, uint underline, uint strikeOut, uint charset, uint output, uint clip, uint quality, uint family, string face);
}
