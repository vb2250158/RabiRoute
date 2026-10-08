using RabiRoute.WindowsHost;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.IO.Pipes;
using System.Threading.Channels;

internal static class IdentityResetTests
{
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;

    internal static async Task RunAsync(Action<bool, string> check)
    {
        check(HostEntry.ParseCommand(["--command", IdentityResetLifecycle.Command]) == IdentityResetLifecycle.Command, "identity reset uses the formal Host command parser");
        check(HostEntry.CommandTimeout(IdentityResetLifecycle.Command) == TimeSpan.FromSeconds(30), "identity reset CLI waits only for queued acknowledgement");
        check(HostRuntime.RequiresDurableAudit(IdentityResetLifecycle.Command) && !HostRuntime.AuditAllowsDispatch(IdentityResetLifecycle.Command, false), "identity reset requires durable lifecycle audit");
        var root = Path.Combine(Path.GetTempPath(), "rabi-identity-host-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var request = new IdentityResetRequest(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));
            var payload = JsonSerializer.SerializeToElement(new { operationId = request.OperationId, expectedGuid = request.ExpectedGuid });
            var requestPath = Path.Combine(root, "request.json");
            File.WriteAllText(requestPath, payload.GetRawText());
            check(IdentityResetLifecycle.ParseRequest(IdentityResetLifecycle.ReadRequest(requestPath)) == request, "private request reader preserves the exact operation and expected GUID");
            foreach (var invalid in new[]
            {
                "{}", "[]", "null",
                JsonSerializer.Serialize(new { operationId = request.OperationId, expectedGuid = request.ExpectedGuid, rabiName = "unaccepted" }),
                $"{{\"operationId\":\"{request.OperationId}\",\"expectedGuid\":\"{request.ExpectedGuid}\",\"expectedGuid\":\"{request.ExpectedGuid}\"}}",
                JsonSerializer.Serialize(new { operationId = "../escape", expectedGuid = request.ExpectedGuid }),
                JsonSerializer.Serialize(new { operationId = Guid.Empty.ToString("D"), expectedGuid = request.ExpectedGuid }),
                JsonSerializer.Serialize(new { OperationId = request.OperationId, expectedGuid = request.ExpectedGuid })
            })
            {
                var refused = false;
                try { using var document = JsonDocument.Parse(invalid); IdentityResetLifecycle.ParseRequest(document.RootElement); }
                catch (InvalidDataException) { refused = true; }
                check(refused, "identity reset rejects wrong, extra, duplicate and non-UUID fields");
            }
            File.WriteAllBytes(requestPath, new byte[IdentityResetLifecycle.MaximumRequestBytes + 1]);
            check(await HostEntry.RunAsync(["--command", IdentityResetLifecycle.Command, "--identity-reset-request", requestPath], root, root) == 64,
                "oversized identity request is rejected before Host startup");
            await using (var wire = new MemoryStream())
            {
                await HostProtocol.WriteAsync(wire, new HostRequest(IdentityResetLifecycle.Command, "fence", IdentityReset: payload), CancellationToken.None);
                wire.Position = 0;
                var decoded = await HostProtocol.ReadAsync<HostRequest>(wire, CancellationToken.None);
                check(decoded.IdentityReset is { } decodedPayload && IdentityResetLifecycle.ParseRequest(decodedPayload) == request, "Host pipe preserves the identity reset request");
            }

            var node = FindNode();
            var package = Path.Combine(root, "package");
            Directory.CreateDirectory(Path.Combine(package, "dist", "manager"));
            File.Copy(node, Path.Combine(package, "node.exe"));
            var script = Path.Combine(package, "dist", "manager", "deviceIdentityCli.js");
            File.WriteAllText(script, FixtureScript);
            await RunQueuedLifecycleAsync(root, package, check);
            await RunWireAcknowledgementAsync(root, package, check);
            await RunRecoveryAsync(root, package, check);
            await RunFailedRecoveryAsync(root, package, check);
            await RunCanceledHelperAsync(root, package, script, check);
        }
        finally
        {
            if (!string.Equals(Path.GetDirectoryName(Path.GetFullPath(root)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Unsafe identity Host fixture cleanup.");
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task RunQueuedLifecycleAsync(string root, string package, Action<bool, string> check)
    {
        var stateRoot = Path.Combine(root, "queued-state");
        Directory.CreateDirectory(stateRoot);
        await using var log = new HostLog(Path.Combine(stateRoot, "logs", "host"));
        var audit = new MemoryAudit();
        var runtime = new HostRuntime(package, stateRoot, log, audit);
        SetPublication(runtime, "faulted", "faulted-fence");
        var unfenced = NewCommand(null);
        var stale = NewCommand("stale-fence");
        foreach (var refused in new[] { unfenced, stale })
        {
            var result = await ExecuteAsync(runtime, refused);
            check(result is null && !(await refused.Completion.Task).Ok, "faulted identity reset rejects missing and stale generation fences");
            check(!Directory.Exists(Path.Combine(stateRoot, "data")), "rejected identity fence never enters offline persistence");
        }
        var command = NewCommand("faulted-fence");
        var transition = ExecuteAsync(runtime, command);
        var acknowledgement = await command.Completion.Task.WaitAsync(TimeSpan.FromSeconds(5));
        check(acknowledgement.Ok && acknowledgement.State == "queued", "faulted Host accepts reset with its exact retained fence");
        check(!transition.IsCompleted && !File.Exists(Path.Combine(stateRoot, "fixture-call.json")), "identity reset waits for acknowledgement delivery before running offline owner");
        check(ReadStatus(stateRoot, command).GetProperty("state").GetString() == "queued", "queued Host receipt is persisted before stopping the generation");
        check(audit.Events.Any(entry => entry.Phase == "queued") && !audit.Events.Any(entry => entry.Phase == "completed"), "queued identity acknowledgement is not a terminal success audit");
        command.ResponseSent.TrySetResult(true);
        check(await transition == "restart", "verified offline reset requests a replacement generation");
        check(ReadStatus(stateRoot, command).GetProperty("state").GetString() == "queued", "offline transaction commit alone does not confirm replacement Manager READY");
        using var observed = JsonDocument.Parse(File.ReadAllText(Path.Combine(stateRoot, "fixture-call.json")));
        check(observed.RootElement.GetProperty("parentPid").GetInt32() == Environment.ProcessId, "offline helper is a direct managed Host child");
        check(observed.RootElement.GetProperty("leaseValid").GetBoolean(), "offline lease is bound to Host PID, root and random nonce");
        check(observed.RootElement.GetProperty("privateEnvironmentCleared").GetBoolean(), "offline helper does not inherit control authority or Node preload options");
        audit.AllowTerminal = false;
        var terminalRefused = false;
        try { typeof(HostRuntime).GetMethod("CompleteIdentityResetAtReady", Private)!.Invoke(runtime, null); }
        catch (TargetInvocationException exception) when (exception.InnerException is InvalidOperationException) { terminalRefused = true; }
        check(terminalRefused && ReadStatus(stateRoot, command).GetProperty("state").GetString() == "queued", "terminal audit failure cannot publish committed Host status");
        check(File.Exists(Path.Combine(stateRoot, "host", "identity-reset-active.json")), "terminal audit failure retains the owned recovery marker");
        audit.AllowTerminal = true;
        typeof(HostRuntime).GetMethod("CompleteIdentityResetAtReady", Private)!.Invoke(runtime, null);
        var completed = ReadStatus(stateRoot, command);
        check(completed.GetProperty("state").GetString() == "committed" && completed.GetProperty("operationId").GetString() == command.IdentityReset!.OperationId,
            "only replacement READY finalizes the exact Host identity operation");
        check(audit.Events.Last(entry => entry.Phase == "completed").Reason == "replacement_generation_ready", "identity reset terminal audit identifies replacement READY");
        check(!File.Exists(Path.Combine(stateRoot, "host", "identity-reset-active.json")), "completed Host operation removes only its own recovery marker");
        check(Directory.GetFiles(Path.Combine(stateRoot, "logs", "host", "identity-reset"), "*.stdout.json", SearchOption.AllDirectories).Length == 1,
            "managed identity helper retains private stdout evidence");

        var disconnected = NewCommand("faulted-fence");
        var disconnectedWork = ExecuteAsync(runtime, disconnected);
        await disconnected.Completion.Task.WaitAsync(TimeSpan.FromSeconds(5));
        disconnected.ResponseSent.TrySetResult(false);
        check(await disconnectedWork is null && ReadStatus(stateRoot, disconnected).GetProperty("state").GetString() == "failed",
            "failed queued acknowledgement does not reset the identity");
        check(!File.Exists(Path.Combine(stateRoot, "host", "identity-reset-active.json")), "unconfirmed acknowledgement leaves no pending reset marker");
        audit.AllowQueued = false;
        var unaudited = NewCommand("faulted-fence");
        check(await ExecuteAsync(runtime, unaudited) is null && !(await unaudited.Completion.Task).Ok, "unpersisted queued audit rejects the reset before offline execution");
        check(!File.Exists(Path.Combine(stateRoot, "host", "identity-reset-active.json")), "rejected queue leaves no marker that could later reset an unacknowledged identity");
    }

    private static async Task RunWireAcknowledgementAsync(string root, string package, Action<bool, string> check)
    {
        var stateRoot = Path.Combine(root, "wire-state");
        Directory.CreateDirectory(stateRoot);
        await using var log = new HostLog(Path.Combine(stateRoot, "logs", "host"));
        var audit = new MemoryAudit();
        var runtime = new HostRuntime(package, stateRoot, log, audit);
        SetPublication(runtime, "faulted", "wire-fence");
        var request = new IdentityResetRequest(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));
        var payload = JsonSerializer.SerializeToElement(new { operationId = request.OperationId, expectedGuid = request.ExpectedGuid });
        var pipeName = "RabiRoute.Identity.Tests." + Guid.NewGuid().ToString("N");
        await using var server = HostProtocol.CreateServer(pipeName);
        using var slots = new SemaphoreSlim(0, 1);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var connection = server.WaitForConnectionAsync(timeout.Token);
        var responseTask = HostProtocol.SendAsync(IdentityResetLifecycle.Command, "wire-fence", TimeSpan.FromSeconds(20), pipeName, identityReset: payload);
        await connection;
        var handler = (Task)typeof(HostRuntime).GetMethod("HandleControlConnectionAsync", Private)!.Invoke(runtime, new object[] { server, slots, timeout.Token })!;
        var commands = (Channel<QueuedCommand>)typeof(HostRuntime).GetField("_commands", Private)!.GetValue(runtime)!;
        var command = await commands.Reader.ReadAsync(timeout.Token);
        var transition = ExecuteAsync(runtime, command);
        var response = await responseTask;
        check(response is { Ok: true, State: "queued", AuditPersisted: true } && response.OperationId == request.OperationId,
            "real Host pipe returns queued acknowledgement with the caller's exact operation UUID");
        await handler;
        check(await transition == "restart", "offline transition follows completed real Host acknowledgement");
        check(!audit.Events.Any(entry => entry.Phase == "completed"), "real queued pipe acknowledgement does not record terminal success");
        typeof(HostRuntime).GetMethod("CompleteIdentityResetAtReady", Private)!.Invoke(runtime, null);
    }

    private static async Task RunRecoveryAsync(string root, string package, Action<bool, string> check)
    {
        var stateRoot = Path.Combine(root, "recover-state");
        Directory.CreateDirectory(stateRoot);
        await using var log = new HostLog(Path.Combine(stateRoot, "logs", "host"));
        var lifecycle = new IdentityResetLifecycle(package, stateRoot, log);
        var request = new IdentityResetRequest(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));
        lifecycle.Queue(request);
        var recovered = new HostRuntime(package, stateRoot, log, new MemoryAudit());
        var safe = await (Task<bool>)typeof(HostRuntime).GetMethod("RecoverIdentityResetBeforeStartupAsync", Private)!.Invoke(recovered, new object[] { CancellationToken.None })!;
        check(safe && ReadStatus(stateRoot, request).GetProperty("state").GetString() == "queued", "cold Host recovers its pending identity transaction before Manager startup");
        typeof(HostRuntime).GetMethod("CompleteIdentityResetAtReady", Private)!.Invoke(recovered, null);
        check(ReadStatus(stateRoot, request).GetProperty("state").GetString() == "rolled_back", "safe recovery is finalized as rollback only after replacement READY");
        lifecycle.Queue(new(Guid.NewGuid().ToString("D"), request.ExpectedGuid));
        var conflict = false;
        try { lifecycle.Queue(request); } catch (InvalidDataException) { conflict = true; }
        check(conflict, "another reset cannot replace a pending recovery owner");

        var rollbackRoot = Path.Combine(root, "foreign-rollback-state");
        Directory.CreateDirectory(rollbackRoot);
        var rollbackOwner = new IdentityResetLifecycle(package, rollbackRoot, log);
        rollbackOwner.Queue(request);
        var rollbackRuntime = new HostRuntime(package, rollbackRoot, log, new MemoryAudit());
        check(await (Task<bool>)typeof(HostRuntime).GetMethod("RecoverIdentityResetBeforeStartupAsync", Private)!.Invoke(rollbackRuntime, new object[] { CancellationToken.None })!,
            "confirmed foreign rollback is eligible for normal Manager admission");
        SetPublication(rollbackRuntime, "faulted", "rollback-fence");
        typeof(HostRuntime).GetMethod("FailIdentityResetAtCircuitOpen", Private)!.Invoke(rollbackRuntime, null);
        check(ReadStatus(rollbackRoot, request).GetProperty("state").GetString() == "failed", "foreign rollback whose Manager cannot reach READY remains a failed Host operation");
        check(!File.Exists(Path.Combine(rollbackRoot, "host", "identity-reset-active.json")), "durably failed READY releases only a resolved offline operation's marker");
        rollbackOwner.Queue(new(Guid.NewGuid().ToString("D"), request.ExpectedGuid));
        check(Directory.GetDirectories(Path.Combine(rollbackRoot, "data", "rabilink", "identity-resets")).Length == 2,
            "faulted foreign rollback permits an explicit fresh reset while retaining prior operation evidence");
    }

    private static async Task RunFailedRecoveryAsync(string root, string package, Action<bool, string> check)
    {
        var stateRoot = Path.Combine(root, "failure-state");
        Directory.CreateDirectory(stateRoot);
        File.WriteAllText(Path.Combine(stateRoot, "fixture-fail"), "both");
        await using var log = new HostLog(Path.Combine(stateRoot, "logs", "host"));
        var runtime = new HostRuntime(package, stateRoot, log, new MemoryAudit());
        SetPublication(runtime, "faulted", "failed-fence");
        var command = NewCommand("failed-fence");
        var transition = ExecuteAsync(runtime, command);
        await command.Completion.Task.WaitAsync(TimeSpan.FromSeconds(5));
        command.ResponseSent.TrySetResult(true);
        check(await transition == "identity-reset-failed", "unconfirmed reset and recovery keep Host faulted instead of restarting Manager");
        check(ReadStatus(stateRoot, command).GetProperty("state").GetString() == "failed", "failed identity recovery persists the original operation receipt");
        check(typeof(HostRuntime).GetField("_generation", Private)!.GetValue(runtime) is null, "failed offline recovery creates no Manager generation");
        check(File.Exists(Path.Combine(stateRoot, "host", "identity-reset-active.json")), "failed offline recovery retains its owned marker for bounded recovery");
        using var trace = JsonDocument.Parse(File.ReadAllText(Path.Combine(stateRoot, "fixture-call.json")));
        check(trace.RootElement.GetProperty("action").GetString() == "recover", "reset failure is reconciled through the same offline owner");
    }

    private static async Task RunCanceledHelperAsync(string root, string package, string script, Action<bool, string> check)
    {
        File.WriteAllText(script, "const fs=require('fs'); const cp=require('child_process'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('descendant.pid',String(child.pid)); setInterval(()=>{},1000);");
        var stateRoot = Path.Combine(root, "cancel-state");
        Directory.CreateDirectory(stateRoot);
        await using var log = new HostLog(Path.Combine(stateRoot, "logs", "host"));
        var lifecycle = new IdentityResetLifecycle(package, stateRoot, log);
        using var cancellation = new CancellationTokenSource();
        var descendantPath = Path.Combine(stateRoot, "descendant.pid");
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var watcher = new FileSystemWatcher(stateRoot, "descendant.pid");
        watcher.Created += (_, _) => started.TrySetResult();
        watcher.EnableRaisingEvents = true;
        var helper = lifecycle.RunOfflineAsync(new(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D")), false, cancellation.Token);
        // Cancel an actually running helper, rather than racing Node startup.
        try { await started.Task.WaitAsync(TimeSpan.FromSeconds(15)); }
        finally
        {
            cancellation.Cancel();
            try { await helper; } catch (OperationCanceledException) { }
        }
        var canceled = false;
        try { await helper; }
        catch (OperationCanceledException) { canceled = true; }
        check(canceled, "offline helper has a bounded cancelable lifetime");
        var childPid = int.Parse(File.ReadAllText(descendantPath));
        var childExited = false;
        try { using var child = Process.GetProcessById(childPid); childExited = child.HasExited; } catch (ArgumentException) { childExited = true; }
        check(childExited, "Host Job cancellation prevents an identity helper descendant becoming an orphan");
        check(Directory.GetFiles(Path.Combine(stateRoot, "data", "rabilink", "identity-resets"), ".offline-lease-*.json", SearchOption.AllDirectories).Length == 0,
            "offline lease is removed after every helper and descendant have exited");
    }

    private static QueuedCommand NewCommand(string? fence)
    {
        var request = new IdentityResetRequest(Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"));
        var peer = new HostControlPeerSnapshot(null, null, null, null, null, null, null, null, Array.Empty<string>());
        return new(IdentityResetLifecycle.Command, fence, new(request.OperationId, DateTimeOffset.UtcNow, peer, "interactive-host-cli"),
            new(TaskCreationOptions.RunContinuationsAsynchronously), new(TaskCreationOptions.RunContinuationsAsynchronously), IdentityReset: request);
    }

    private static Task<string?> ExecuteAsync(HostRuntime runtime, QueuedCommand command) =>
        (Task<string?>)typeof(HostRuntime).GetMethod("ExecuteIdentityResetAsync", Private)!.Invoke(runtime, new object?[] { command, null, CancellationToken.None })!;

    private static void SetPublication(HostRuntime runtime, string state, string fence)
    {
        typeof(HostRuntime).GetField("_state", Private)!.SetValue(runtime, state);
        typeof(HostRuntime).GetField("_fenceGenerationId", Private)!.SetValue(runtime, fence);
        typeof(HostRuntime).GetField("_publication", Private)!.SetValue(runtime, new LifecyclePublication(state, fence));
    }

    private static JsonElement ReadStatus(string root, QueuedCommand command) => ReadStatus(root, command.IdentityReset!);
    private static JsonElement ReadStatus(string root, IdentityResetRequest request)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "data", "rabilink", "identity-resets", request.OperationId, "host-status.json")));
        return document.RootElement.Clone();
    }

    private static string FindNode() => (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)
        .Select(directory => Path.Combine(directory.Trim('"'), "node.exe")).First(File.Exists);

    private sealed class MemoryAudit : IHostLifecycleAudit
    {
        internal List<HostAuditEvent> Events { get; } = new();
        internal bool AllowTerminal { get; set; } = true;
        internal bool AllowQueued { get; set; } = true;
        public bool Append(HostAuditEvent entry) { Events.Add(entry); return (entry.Phase != "completed" || AllowTerminal) && (entry.Phase != "queued" || AllowQueued); }
    }

    private const string FixtureScript = """
        const fs = require('fs'); const path = require('path'); const args = process.argv.slice(2); const action = args.shift();
        const values = new Map(); for(let index=0;index<args.length;index+=2) values.set(args[index],args[index+1]);
        const root=values.get('--state-root'), op=values.get('--operation-id'), old=values.get('--expected-guid');
        const lease=JSON.parse(fs.readFileSync(values.get('--offline-lease'),'utf8'));
        const leaseValid=lease.schemaVersion===1 && lease.pid===process.ppid && lease.stateRoot===root && /^[a-f0-9]{64}$/.test(lease.nonce);
        const privateEnvironmentCleared=!process.env.RABIROUTE_HOST_CONTROL_TOKEN && !process.env.NODE_OPTIONS && !process.env.NODE_PATH;
        fs.writeFileSync(path.join(root,'fixture-call.json'),JSON.stringify({action,parentPid:process.ppid,leaseValid,privateEnvironmentCleared}));
        if(!leaseValid || !privateEnvironmentCleared || fs.existsSync(path.join(root,'fixture-fail'))) { console.log(JSON.stringify({ok:false,error:'identity_fixture_failed'})); process.exitCode=1; }
        else console.log(JSON.stringify({ok:true,receipt:{schemaVersion:1,operationId:op,oldGuid:old,newGuid:action==='recover'?old:'12345678-1234-4234-8234-123456789abc',outcome:action==='recover'?'rolled_back':'committed',completedAt:new Date().toISOString()}}));
        """;
}
