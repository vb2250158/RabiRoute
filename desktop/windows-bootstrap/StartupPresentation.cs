using System.Text.Json;

namespace RabiRoute.WindowsBootstrap;

internal sealed record StartupDisplay(string Message, bool IsError = false);

internal interface IStartupWindow : IDisposable
{
    Task Ready { get; }
    Task Closed { get; }
    event Action? Dismissed;
    void Present(StartupDisplay display);
    void ApplyTheme(StartupTheme theme);
    void Close();
}

/** Presentation only: the selected Host core still owns startup, recovery and exit. */
internal sealed class StartupPresentation : IAsyncDisposable
{
    private readonly IStartupWindow _window;
    private readonly Func<CancellationToken, Task<ReadOnlyHostStatusResult>> _probe;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly CancellationTokenSource _lifetime = new();
    private Task? _monitor;

    internal StartupPresentation(IStartupWindow window,
        Func<CancellationToken, Task<ReadOnlyHostStatusResult>> probe,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _window = window;
        _probe = probe;
        _delay = delay ?? Task.Delay;
        window.Dismissed += OnDismissed;
    }

    internal static bool IsForegroundLaunch(string[] args) => args.Length == 0;

    internal static async Task<StartupPresentation?> TryStartAsync(string[] args)
    {
        if (!IsForegroundLaunch(args)) return null;
        StartupWindow? window = null;
        try
        {
            window = new StartupWindow();
            await window.Ready;
            return new StartupPresentation(window, ReadOnlyHostStatusProbe.QueryAsync);
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // A presentation failure must not prevent the original Host startup.
            window?.Dispose();
            return null;
        }
    }

    internal void ApplyTheme(string stateRoot) => _window.ApplyTheme(StartupTheme.Load(stateRoot));

    internal void Present(string message) => _window.Present(new StartupDisplay(message));

    internal void ObserveHost() => _monitor ??= MonitorAsync();

    internal async Task WaitForHandoffAsync()
    {
        ObserveHost();
        await Task.WhenAny(_monitor!, _window.Closed);
    }

    internal void Complete() => _window.Close();

    internal async Task FollowActivationAsync(int activationExitCode)
    {
        if (activationExitCode == 0) Complete();
        else await WaitForHandoffAsync(); // An already-starting Host has no active surface yet.
    }

    internal async Task ShowFailureAsync(string message)
    {
        _lifetime.Cancel();
        _window.Present(new StartupDisplay(message, IsError: true));
        await _window.Closed;
    }

    private void OnDismissed() => _lifetime.Cancel();

    private async Task MonitorAsync()
    {
        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                var result = await _probe(_lifetime.Token);
                if (result.ReceivedResponse)
                {
                    using var document = JsonDocument.Parse(result.Json);
                    var root = document.RootElement;
                    var state = root.TryGetProperty("state", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
                    if (result.Ok && state is "healthy" or "degraded" or "stopped")
                    {
                        _window.Close();
                        return;
                    }
                    var message = state switch
                    {
                        "starting" => "正在启动 RabiRoute 服务…",
                        "recovering" or "backoff" => "RabiRoute 正在恢复服务…",
                        "stopping" => "RabiRoute 正在退出…",
                        "faulted" => "RabiRoute 启动未完成，请查看宿主日志。可关闭此窗口并在后台处理。",
                        _ => "正在等待 RabiRoute 就绪…"
                    };
                    _window.Present(new StartupDisplay(message, state == "faulted"));
                }
                else
                {
                    // A disconnected/busy pipe is not evidence of startup failure or completion.
                    _window.Present(new StartupDisplay("正在连接 RabiRoute 宿主…"));
                }
                await _delay(TimeSpan.FromMilliseconds(500), _lifetime.Token);
            }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error) when (error is IOException or JsonException or InvalidDataException)
        {
            _window.Present(new StartupDisplay("暂时无法读取启动状态，可关闭此窗口并继续后台启动。", IsError: true));
            await _window.Closed;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _window.Dismissed -= OnDismissed;
        _lifetime.Cancel();
        _window.Dispose();
        if (_monitor is not null) await _monitor;
        await _window.Closed;
        _lifetime.Dispose();
    }
}
