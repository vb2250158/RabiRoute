using RabiRoute.WindowsHost;

internal static class TimeoutSettingsTests
{
    internal static void Run(Action<bool, string> check)
    {
        var fallback = TimeSpan.FromSeconds(3);
        try
        {
            HostTimeouts.Configure("{\"timeoutOverrides\":{\"host.manager.ready\":65000,\"bad\":-1,\"string\":\"10\"}}");
            check(ApplicationGeneration.ManagerReadyTimeout == TimeSpan.FromMilliseconds(65000), "Host adopts the persisted millisecond override");
            check(HostTimeouts.Get("bad", fallback) == fallback && HostTimeouts.Get("string", fallback) == fallback, "invalid individual Host settings preserve defaults");
            check(HostEntry.CommandTimeout("restart") >= ApplicationGeneration.ManagerReadyTimeout + ApplicationGeneration.TrayReadyTimeout, "outer Host startup command covers configured readiness waits");
            HostTimeouts.Configure("{\"timeoutOverrides\":{\"host.manager.ready\":2147483647,\"host.tray.ready\":2147483647,\"host.command.startGrace\":2147483647}}");
            using (var deadline = HostTimeouts.Deadline(HostEntry.CommandTimeout("restart")))
                check(!deadline.Token.IsCancellationRequested, "maximum valid component settings do not overflow the composite Host timer");
            using (var deadline = HostTimeouts.Deadline(TimeSpan.FromMilliseconds(5)))
                check(deadline.Token.WaitHandle.WaitOne(TimeSpan.FromSeconds(2)), "Host deadline still cancels a real wait");
            HostTimeouts.Configure("{}");
            check(ApplicationGeneration.ManagerReadyTimeout == TimeSpan.FromMinutes(3), "removing Host override restores default");
        }
        finally { HostTimeouts.Configure("{}"); }
    }
}
