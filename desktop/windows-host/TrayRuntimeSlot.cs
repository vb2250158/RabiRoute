using System.ComponentModel;
using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal sealed record TrayRuntimeStatus(string State, string? Release = null, uint? Pid = null,
    string? ManagerInstanceId = null, string? Executable = null);

internal sealed record TraySwitchResult(bool Ok, string State, string Message);

// A Tray attempt has a job of its own inside the application generation job.
// The generation retains the ultimate cleanup authority for both children.
internal sealed class TrayRuntimeSlot(
    string packageRoot, string stateRoot, string generationId, ManagerReady manager, WindowsJob applicationJob,
    HostLog log, bool acceptanceMode) : IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1);
    private readonly object _publicationGate = new();
    private readonly CancellationTokenSource _stopping = new();
    private readonly TaskCompletionSource<string> _failure = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Child? _child;
    private TrayRuntimeStatus _status = new("starting");
    private string _lastReady = TrayRelease.Bundled;
    private sealed record Child(TrayRelease Release, WindowsJob Job, NativeChildProcess Process,
        TrayLifecycleChannel Lifecycle, string Executable, Task<int> Exit);

    internal TrayRuntimeStatus Status => Volatile.Read(ref _status);
    internal Task<string> Failure => _failure.Task;
    internal bool IsReady => Status.State == "ready" && !Failure.IsCompleted;

    internal async Task StartAsync(CancellationToken token)
    {
        var fellBack = false;
        try
        {
            var selection = TrayRelease.ReadSelection(stateRoot);
            if (selection != TrayRelease.Bundled)
            {
                await StartChildAsync(await ResolveAsync(selection, token), token);
                PublishReady();
                return;
            }
        }
        catch (Exception error) when (IsTrayError(error))
        {
            fellBack = true;
            log.Write($"generation={generationId} saved Tray selection failed: {error.Message}; starting bundled Tray");
            await RetireAsync();
        }
        await StartChildAsync(await ResolveAsync(TrayRelease.Bundled, token), token);
        PublishReady();
        if (fellBack)
        {
            try { TrayRelease.SaveSelection(stateRoot, TrayRelease.Bundled); }
            catch (Exception error) when (IsTrayError(error))
            {
                log.Write($"generation={generationId} could not persist bundled Tray fallback: {error.Message}");
            }
        }
    }

    internal async Task<TraySwitchResult> SwitchAsync(string selection, Action statusChanged, CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(0, cancellationToken))
            return new(false, "busy", "A Tray switch is already in progress.");
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stopping.Token);
            var token = linked.Token;
            token.ThrowIfCancellationRequested();
            if (Status is { State: "ready" } status && status.Release == selection)
                return new(true, "ready", "The requested Tray release is already active.");

            TrayRelease candidate;
            try { candidate = await ResolveAsync(selection, token); }
            catch (Exception error) when (IsTrayError(error))
            {
                return new(false, "tray_candidate_invalid", error.Message);
            }
            token.ThrowIfCancellationRequested();
            lock (_publicationGate)
            {
                if (_failure.Task.IsCompleted)
                    return new(false, "stale_generation", "The application generation is recovering.");
                Volatile.Write(ref _status, new("switching", _lastReady));
            }
            statusChanged();

            try
            {
                await RetireAsync();
                token.ThrowIfCancellationRequested();
                await StartChildAsync(candidate, token);
                token.ThrowIfCancellationRequested();
                TrayRelease.SaveSelection(stateRoot, selection);
                PublishReady();
                return new(true, "ready", "The Tray release is active.");
            }
            catch (Exception error) when (IsTrayError(error))
            {
                log.Write($"generation={generationId} Tray switch to {selection} failed: {error.Message}");
                try
                {
                    await RetireAsync();
                    token.ThrowIfCancellationRequested();
                    await StartChildAsync(await ResolveAsync(_lastReady, token), token);
                    PublishReady();
                    return new(false, "tray_rolled_back", error.Message);
                }
                catch (Exception rollbackError) when (IsTrayError(rollbackError))
                {
                    log.Write($"generation={generationId} Tray rollback failed: {rollbackError.Message}");
                    try { await RetireAsync(); }
                    catch (Exception retireError) when (IsTrayError(retireError))
                    {
                        log.Write($"generation={generationId} Tray exit could not be confirmed: {retireError.Message}");
                    }
                    SetStatus(new("unavailable", _lastReady));
                    return new(false, "tray_unavailable", $"Tray switch and rollback failed: {rollbackError.Message}");
                }
            }
        }
        finally
        {
            try { statusChanged(); }
            finally { _gate.Release(); }
        }
    }

    private Task<TrayRelease> ResolveAsync(string selection, CancellationToken token) =>
        Task.Run(() => TrayRelease.Resolve(packageRoot, stateRoot, selection, token), token);

    private async Task StartChildAsync(TrayRelease release, CancellationToken token)
    {
        if (_child is not null) throw new InvalidOperationException("Previous Tray still owns its job.");
        token.ThrowIfCancellationRequested();
        var trayExecutable = Path.Combine(release.Root, "python", "pythonw.exe");
        var trayMain = Path.Combine(release.Root, "main.py");
        if (!File.Exists(trayExecutable)) throw new FileNotFoundException("Qt runtime is missing.", trayExecutable);
        if (!File.Exists(trayMain)) throw new FileNotFoundException("Qt entry is missing.", trayMain);

        var job = new WindowsJob($"{generationId}-tray");
        TrayLifecycleChannel? lifecycle = null;
        NativeChildProcess process;
        try
        {
            lifecycle = new TrayLifecycleChannel(generationId);
            process = NativeChildProcess.StartSuspendedInJob(
                applicationJob, trayExecutable,
                ApplicationGeneration.BuildTrayArguments(trayMain, manager, generationId,
                    Environment.ProcessPath ?? Path.Combine(stateRoot, "RabiRouteHost.exe"), lifecycle.PipeName),
                stateRoot, acceptanceMode
                    ? ApplicationGeneration.BuildAcceptanceTrayEnvironment(packageRoot, stateRoot, generationId)
                    : ApplicationGeneration.BuildTrayEnvironment(packageRoot, stateRoot, generationId),
                isolatedEnvironment: acceptanceMode, childJob: job);
        }
        catch
        {
            job.Dispose();
            if (lifecycle is not null) await lifecycle.DisposeAsync();
            throw;
        }

        var child = new Child(release, job, process, lifecycle, trayExecutable, process.WaitForExitAsync());
        _child = child;
        _ = ApplicationGeneration.PumpLinesAsync(process.StandardOutput, "tray stdout", generationId, log);
        _ = ApplicationGeneration.PumpLinesAsync(process.StandardError, "tray stderr", generationId, log);
        using var readinessCancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
        var readiness = lifecycle.WaitForReadyAsync(generationId, manager.ManagerInstanceId,
            process.ProcessId, ApplicationGeneration.TrayReadyTimeout, readinessCancellation.Token);
        if (await Task.WhenAny(child.Exit, readiness) == child.Exit)
        {
            readinessCancellation.Cancel();
            try { await readiness; } catch (OperationCanceledException) { }
            throw new InvalidOperationException($"Tray exited before exact lifecycle READY with code {await child.Exit}.");
        }
        if (await readiness is null || process.HasExited)
            throw new TimeoutException("Tray did not publish exact lifecycle READY.");
        log.Write($"generation={generationId} tray pid={process.ProcessId} release={release.Selection} published exact lifecycle READY after exact Manager READY");
    }

    private void PublishReady()
    {
        var child = _child!;
        _lastReady = child.Release.Selection;
        SetStatus(new("ready", _lastReady, child.Process.ProcessId, manager.ManagerInstanceId, child.Executable));
        _ = ObserveExitAsync(child);
    }

    private async Task ObserveExitAsync(Child child)
    {
        string failure;
        try { failure = $"tray-exited:{await child.Exit}"; }
        catch (Exception error) { failure = $"tray-monitor-failed:{error.GetType().Name}"; }
        lock (_publicationGate)
        {
            if (_status.State == "ready" && _status.Pid == child.Process.ProcessId &&
                ReferenceEquals(_child, child) && !_stopping.IsCancellationRequested)
                _failure.TrySetResult(failure);
        }
    }

    private void SetStatus(TrayRuntimeStatus status)
    {
        lock (_publicationGate) Volatile.Write(ref _status, status);
    }

    private async Task RetireAsync()
    {
        var child = _child;
        if (child is null) return;
        try
        {
            if (!child.Process.HasExited && await child.Lifecycle.RequestShutdownAsync(
                    HostTimeouts.Get("host.tray.shutdownRequest", TimeSpan.FromSeconds(3)), CancellationToken.None))
                await Task.WhenAny(child.Exit, Task.Delay(HostTimeouts.Get("host.tray.exit", TimeSpan.FromSeconds(5))));
        }
        catch (Exception error) when (IsTrayError(error))
        {
            log.Write($"generation={generationId} graceful Tray close failed: {error.Message}");
        }
        if (child.Job.MemberProcessIds().Count != 0) child.Job.Terminate();
        await child.Job.WaitForEmptyAsync(new[] { child.Process }, CancellationToken.None);
        await DisposeChildAsync(child);
        _child = null;
    }

    internal async Task StopAsync()
    {
        _stopping.Cancel();
        await _gate.WaitAsync();
        try
        {
            SetStatus(new("stopping", _lastReady));
            await RetireAsync();
        }
        finally { _gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        _stopping.Cancel();
        if (_child is { } child) await DisposeChildAsync(child);
        _gate.Dispose();
        _stopping.Dispose();
    }

    private static async Task DisposeChildAsync(Child child)
    {
        try { await child.Exit; }
        catch (Win32Exception) when (child.Process.HasExited) { }
        await child.Lifecycle.DisposeAsync();
        child.Process.Dispose();
        child.Job.Dispose();
    }

    private static bool IsTrayError(Exception error) => error is IOException or InvalidDataException or UnauthorizedAccessException or
        TimeoutException or InvalidOperationException or Win32Exception or JsonException;
}
