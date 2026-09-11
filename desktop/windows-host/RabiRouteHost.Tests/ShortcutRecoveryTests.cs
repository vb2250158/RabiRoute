using RabiRoute.WindowsHost;
using System.Reflection;
using System.Threading.Channels;

internal static class ShortcutRecoveryTests
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        check(HostEntry.CommandTimeout("activate") >= ApplicationGeneration.ManagerReadyTimeout + ApplicationGeneration.TrayReadyTimeout,
            "shortcut recovery waits for the complete cold-start budget");
        check(HostEntry.CommandTimeout("status") == TimeSpan.FromSeconds(30), "status retains its short bounded request");
        var root = Path.Combine(Path.GetTempPath(), "shortcut-recovery-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await using var log = new HostLog(root);
            var runtime = new HostRuntime(root, root, log, new HostLifecycleAudit(root));
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
            var type = typeof(HostRuntime);
            type.GetField("_state", flags)!.SetValue(runtime, "faulted");
            type.GetField("_fenceGenerationId", flags)!.SetValue(runtime, "retained-fence");
            type.GetField("_publication", flags)!.SetValue(runtime, new LifecyclePublication("faulted", "retained-fence"));
            var commands = (Channel<QueuedCommand>)type.GetField("_commands", flags)!.GetValue(runtime)!;
            var operation = (HostOperationContext)type.GetMethod("InternalOperation", flags)!.Invoke(runtime, null)!;
            var response = new TaskCompletionSource<HostResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
            var activate = new QueuedCommand("activate", null, operation, response,
                new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously));
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var wait = (Task<string>)type.GetMethod("WaitInFaultedStateAsync", flags)!.Invoke(runtime, new object[] { deadline.Token })!;
            await commands.Writer.WriteAsync(activate, deadline.Token);
            check(await wait == "restart", "ordinary shortcut enters the existing Host recovery loop");
            var transition = (PendingTransition)type.GetField("_pendingTransition", flags)!.GetValue(runtime)!;
            check(transition.RequestedGenerationId == "retained-fence", "shortcut captures the exact faulted generation fence");
            check(transition.ClientCommand?.Command == "activate", "recovery retains activation intent for opening the ready surface");
            check(transition.AuditPersisted, "shortcut recovery retains durable lifecycle audit");
            check(!response.Task.IsCompleted, "shortcut does not report success before READY");
            type.GetMethod("FailPendingTransition", flags)!.Invoke(runtime, new object[] { "injected_startup_failure" });
            check(!(await response.Task).Ok, "failed recovery returns failure rather than a successful launch receipt");
        }
        finally { Directory.Delete(root, true); }
    }
}
