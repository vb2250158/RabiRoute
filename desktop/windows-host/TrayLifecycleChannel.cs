using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal sealed class TrayLifecycleChannel : IAsyncDisposable
{
    private readonly NamedPipeServerStream _server;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _connection;
    private readonly Task<string?> _readiness;
    private int _shutdownSent;
    private int _readyAccepted;

    internal TrayLifecycleChannel(string generationId)
    {
        PipeName = $"RabiRoute.Tray.{generationId}.{Guid.NewGuid():N}";
        _server = new NamedPipeServerStream(
            PipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        _connection = _server.WaitForConnectionAsync(_lifetime.Token);
        _readiness = ReadReadinessAsync();
    }

    internal string PipeName { get; }

    internal async Task<bool> WaitForConnectionAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            await _connection.WaitAsync(timeoutSource.Token);
            return true;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    internal async Task<TrayReady?> WaitForReadyAsync(
        string applicationGenerationId,
        string managerInstanceId,
        uint expectedPid,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            var line = await _readiness.WaitAsync(timeoutSource.Token);
            var ready = TrayReadiness.Parse(line, applicationGenerationId, managerInstanceId, expectedPid);
            if (ready is null) return null;
            Interlocked.Exchange(ref _readyAccepted, 1);
            return ready;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or JsonException)
        {
            return null;
        }
    }

    internal async Task<bool> RequestShutdownAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _shutdownSent, 1) != 0) return false;
        if (Volatile.Read(ref _readyAccepted) == 0) return false;
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            if (!await WaitForConnectionAsync(timeout, cancellationToken)) return false;
            var command = Encoding.UTF8.GetBytes("shutdown\n");
            await _server.WriteAsync(command, timeoutSource.Token);
            await _server.FlushAsync(timeoutSource.Token);
            return true;
        }
        catch (Exception exception) when (exception is OperationCanceledException or IOException or ObjectDisposedException)
        {
            return false;
        }
    }

    private async Task<string?> ReadReadinessAsync()
    {
        await _connection;
        using var reader = new StreamReader(_server, Encoding.UTF8, false, 4096, leaveOpen: true);
        return await reader.ReadLineAsync(_lifetime.Token);
    }

    public ValueTask DisposeAsync()
    {
        try { _lifetime.Cancel(); } catch { }
        _server.Dispose();
        _lifetime.Dispose();
        return ValueTask.CompletedTask;
    }
}


internal static class TrayReadiness
{
    internal const string Prefix = "RABIROUTE_TRAY_READY:";

    internal static TrayReady? Parse(
        string? line,
        string applicationGenerationId,
        string managerInstanceId,
        uint expectedPid)
    {
        if (string.IsNullOrWhiteSpace(line) || !line.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        using var document = JsonDocument.Parse(line[Prefix.Length..]);
        var root = document.RootElement;
        var matches = root.TryGetProperty("protocolVersion", out var protocolVersion) && protocolVersion.GetInt32() == 1
            && root.TryGetProperty("applicationGenerationId", out var generation)
            && generation.GetString() == applicationGenerationId
            && root.TryGetProperty("managerInstanceId", out var manager)
            && manager.GetString() == managerInstanceId
            && root.TryGetProperty("pid", out var pid)
            && pid.TryGetUInt32(out var actualPid)
            && actualPid == expectedPid;
        return matches ? new TrayReady(applicationGenerationId, managerInstanceId, expectedPid) : null;
    }
}

internal sealed record TrayReady(
    string ApplicationGenerationId,
    string ManagerInstanceId,
    uint Pid);
