namespace RabiRoute.WindowsHost;

using System.Text.Json;

public static class HostEntry
{
    private const string TraySwitchCommand = "tray-switch";

    [STAThread]
    public static async Task<int> RunAsync(string[] args, string packageRoot, string stateRoot)
    {
        var acceptanceCount = args.Count(arg => arg.Equals("--acceptance", StringComparison.OrdinalIgnoreCase));
        var effectiveArgs = args.Where(arg => !arg.Equals("--acceptance", StringComparison.OrdinalIgnoreCase)).ToArray();
        var command = ParseCommand(effectiveArgs);
        var generationId = ParseOption(effectiveArgs, "--application-generation-id");
        var jsonOutput = effectiveArgs.Contains("--json", StringComparer.OrdinalIgnoreCase);
        if (jsonOutput) ConsoleBridge.AttachToParent();
        (string Mutex, string Pipe)? acceptance = null;
        if (acceptanceCount > 0)
        {
            try
            {
                if (acceptanceCount != 1 || command == "invalid") throw new InvalidDataException("Invalid acceptance command.");
                acceptance = HostAcceptanceScope.Validate(stateRoot, command is null or "activate");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidDataException)
            {
                if (jsonOutput) WriteJson(new HostResponse(false, "invalid_acceptance", "The isolated acceptance fixture could not be validated."));
                return 64;
            }
        }
        HostTimeouts.Load(stateRoot);
        if (command == "self-test") return RunSelfTest();
        var trayRelease = command == TraySwitchCommand ? ParseOption(effectiveArgs, "--tray-release") : null;
        if (command == TraySwitchCommand && (string.IsNullOrWhiteSpace(generationId) ||
                generationId.StartsWith("--", StringComparison.Ordinal) || !TrayRelease.IsSelection(trayRelease)))
        {
            if (jsonOutput) WriteJson(new HostResponse(false, "invalid_request", "Tray switching requires --application-generation-id and --tray-release <bundled|64 lowercase hex characters>."));
            return 64;
        }
        JsonElement? sourcePatch = null;
        JsonElement? identityReset = null;
        var isWebPatch = SourcePatchTransport.IsWebCommand(command);
        if (SourcePatchTransport.IsCommand(command) || isWebPatch)
        {
            try { sourcePatch = SourcePatchTransport.ReadRequest(ParseOption(args, isWebPatch ? "--web-patch-request" : "--source-patch-request")); }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or ArgumentException or UnauthorizedAccessException)
            {
                if (jsonOutput) WriteJson(new HostResponse(false, "invalid_request", "Source patch request file could not be validated."));
                return 64;
            }
        }
        if (command == IdentityResetLifecycle.Command)
        {
            try { identityReset = IdentityResetLifecycle.ReadRequest(ParseOption(args, "--identity-reset-request")); }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException or ArgumentException or UnauthorizedAccessException)
            {
                if (jsonOutput) WriteJson(new HostResponse(false, "invalid_request", "Identity reset request file could not be validated."));
                return 64;
            }
        }

        using var mutexLease = new NamedMutexLease(acceptance?.Mutex ?? HostIdentity.MutexName);
        if (!mutexLease.OwnsMutex)
        {
            var response = await HostProtocol.SendAsync(
                command ?? "activate",
                generationId,
                CommandTimeout(command ?? "activate"),
                pipeName: acceptance?.Pipe,
                sourcePatch: isWebPatch ? null : sourcePatch,
                webPatch: isWebPatch ? sourcePatch : null,
                identityReset: identityReset,
                trayRelease: trayRelease);
            if (jsonOutput) WriteJson(response ?? new HostResponse(false, "unreachable", "The Host control pipe did not respond."));
            return response?.Ok == true ? 0 : 2;
        }

        if (command == "invalid")
        {
            if (jsonOutput) WriteJson(new HostResponse(false, "stopped", "Unknown Host command."));
            return 64;
        }
        if (command is "quit" or "restart" or "status" or TraySwitchCommand or IdentityResetLifecycle.Command || SourcePatchTransport.IsCommand(command) || isWebPatch)
        {
            var requiresActiveGeneration = command is "quit" or TraySwitchCommand or IdentityResetLifecycle.Command || SourcePatchTransport.IsCommand(command) || isWebPatch;
            var response = requiresActiveGeneration
                ? new HostResponse(false, "stale_generation", "No matching Host generation is running.")
                : new HostResponse(true, "stopped", "No Host instance is running.");
            if (jsonOutput) WriteJson(response);
            return response.Ok ? 0 : 3;
        }
        packageRoot = Path.GetFullPath(packageRoot);
        stateRoot = Path.GetFullPath(stateRoot);
        if (!LocalRuntimePath.IsLocal(packageRoot) || !LocalRuntimePath.IsLocal(stateRoot))
        {
            var response = new HostResponse(false, "invalid_root", "RabiRoute must run from a local Windows disk.");
            await using var rejectedLog = new HostLog();
            rejectedLog.Write($"rejected non-local runtime layout: packageRoot={packageRoot}; stateRoot={stateRoot}");
            if (jsonOutput) WriteJson(response);
            return 78;
        }
        using var cancellation = new CancellationTokenSource();
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        EventHandler exitHandler = (_, _) => cancellation.Cancel();
        Console.CancelKeyPress += cancelHandler;
        AppDomain.CurrentDomain.ProcessExit += exitHandler;
        try
        {
            var hostDiagnosticsRoot = Path.Combine(stateRoot, "logs", "host");
            await using var log = new HostLog(hostDiagnosticsRoot);
            PortableOverlayGuard.WarnForStartup(packageRoot, stateRoot, log.Write);
            return await new HostRuntime(
                packageRoot,
                stateRoot,
                log,
                new HostLifecycleAudit(hostDiagnosticsRoot), controlPipeName: acceptance?.Pipe, acceptanceMode: acceptance.HasValue).RunAsync(cancellation.Token);
        }
        finally
        {
            Console.CancelKeyPress -= cancelHandler;
            AppDomain.CurrentDomain.ProcessExit -= exitHandler;
        }
    }

    internal static TimeSpan CommandTimeout(string command) => command switch
    {
        "activate" or "restart" => ApplicationGeneration.ManagerReadyTimeout + ApplicationGeneration.TrayReadyTimeout + HostTimeouts.Get("host.command.startGrace", TimeSpan.FromSeconds(90)),
        TraySwitchCommand => 2 * ApplicationGeneration.TrayReadyTimeout + HostTimeouts.Get("host.command.startGrace", TimeSpan.FromSeconds(90)),
        _ => HostTimeouts.Get("host.command.request", TimeSpan.FromSeconds(30))
    };

    internal static string? ParseCommand(string[] args)
    {
        if (args.Contains("--allow-unfenced-quit", StringComparer.OrdinalIgnoreCase)) return "invalid";
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index].Equals("--command", StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 >= args.Length) return "invalid";
                var value = args[index + 1].Trim().ToLowerInvariant();
                return value is "quit" or "restart" or "status" or "activate" or TraySwitchCommand or IdentityResetLifecycle.Command || SourcePatchTransport.IsCommand(value) || SourcePatchTransport.IsWebCommand(value) ? value : "invalid";
            }
        }
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase)) return "self-test";
        if (args.Any(argument =>
                argument.Equals("--quit", StringComparison.OrdinalIgnoreCase) ||
                argument.Equals("--restart", StringComparison.OrdinalIgnoreCase) ||
                argument.Equals("--status", StringComparison.OrdinalIgnoreCase) ||
                argument.Equals("--activate", StringComparison.OrdinalIgnoreCase))) return "invalid";
        if (args.Length > 0) return "invalid";
        return null;
    }

    private static string? ParseOption(string[] args, string name)
    {
        for (var index = 0; index < args.Length - 1; index++)
        {
            if (args[index].Equals(name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        }
        return null;
    }

    private static int RunSelfTest()
    {
        try
        {
            using var job = new WindowsJob($"self-test-{Environment.ProcessId}-{Guid.NewGuid():N}");
            return HostIdentity.PipeName.Length > 0 ? 0 : 1;
        }
        catch
        {
            return 1;
        }
    }

    private static void WriteJson(HostResponse response)
    {
        Console.WriteLine(JsonSerializer.Serialize(response, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }));
    }
}

internal static class PortableOverlayGuard
{
    private static readonly string[] RetiredLifecycleEntries =
    {
        "RabiRoute-Desktop.exe",
        "RabiRoute-Tray.exe",
        "RabiRoute-Tray.new.exe",
        "Start-RabiRoute-Tray.bat",
        "Start-RabiRoute-Health-Watchdog.bat",
        "Start-RabiRoute-MessageAdapter-Watchdog.bat",
        Path.Combine("scripts", "Install-RabiRoute-HealthWatchdogTask.ps1"),
        Path.Combine("scripts", "watch-message-adapters.ps1"),
        Path.Combine("scripts", "watch-rabiroute-desktop-lifecycle.ps1"),
        Path.Combine("scripts", "watch-rabiroute-health-hidden.vbs"),
        Path.Combine("scripts", "watch-rabiroute-health.ps1")
    };

    internal static IReadOnlyList<string> FindRetiredLifecycleEntriesForStartup(
        string packageRoot,
        string stateRoot)
    {
        return new[] { Path.GetFullPath(packageRoot), Path.GetFullPath(stateRoot) }
            .SelectMany(FindRetiredLifecycleEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(relativePath => relativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static IReadOnlyList<string> FindRetiredLifecycleEntries(string root)
    {
        var fullRoot = Path.GetFullPath(root);
        return RetiredLifecycleEntries
            .Where(relativePath => File.Exists(Path.Combine(fullRoot, relativePath)))
            .Select(relativePath => relativePath.Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(relativePath => relativePath, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static void WarnForStartup(string packageRoot, string stateRoot, Action<string> writeWarning)
    {
        try
        {
            var retiredEntries = FindRetiredLifecycleEntriesForStartup(packageRoot, stateRoot);
            if (retiredEntries.Count > 0)
            {
                writeWarning($"warning: retired lifecycle entries were ignored; Host startup continues: {string.Join(", ", retiredEntries)}");
            }
        }
        catch (Exception exception)
        {
            // A stale entry or a diagnostic failure cannot become lifecycle authority.
            try { writeWarning($"warning: retired lifecycle entry inspection failed ({exception.GetType().Name}); Host startup continues."); }
            catch { }
        }
    }
}

internal static class LocalRuntimePath
{
    internal static bool IsLocal(string path)
    {
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return false;
        var root = Path.GetPathRoot(path);
        if (string.IsNullOrWhiteSpace(root)) return false;
        try { return new DriveInfo(root).DriveType != DriveType.Network; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
}

internal sealed class NamedMutexLease : IDisposable
{
    private readonly ManualResetEventSlim _initialized = new(false);
    private readonly ManualResetEventSlim _release = new(false);
    private readonly Thread _ownerThread;

    internal NamedMutexLease(string name)
    {
        _ownerThread = new Thread(() => OwnMutex(name))
        {
            IsBackground = false,
            Name = "RabiRoute Host single-instance Mutex owner"
        };
        _ownerThread.Start();
        _initialized.Wait();
    }

    internal bool OwnsMutex { get; private set; }

    private void OwnMutex(string name)
    {
        using var mutex = new Mutex(false, name);
        try { OwnsMutex = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { OwnsMutex = true; }
        finally { _initialized.Set(); }
        if (!OwnsMutex) return;
        _release.Wait();
        mutex.ReleaseMutex();
    }

    public void Dispose()
    {
        _release.Set();
        _ownerThread.Join();
        _release.Dispose();
        _initialized.Dispose();
    }
}

internal static class ConsoleBridge
{
    private const uint AttachParentProcess = 0xFFFFFFFF;

    internal static void AttachToParent()
    {
        NativeMethods.AttachConsole(AttachParentProcess);
        try
        {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
        }
        catch (IOException) { }
    }
}
