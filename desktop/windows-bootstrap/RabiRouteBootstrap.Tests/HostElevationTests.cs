namespace RabiRoute.WindowsBootstrap;

internal static class HostElevationTests
{
    internal static void Run(Action<bool, string> check)
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                using var actual = new WindowsHostElevationDriver(Path.Combine(Path.GetTempPath(),
                    "RabiRoute-missing-task-" + Guid.NewGuid().ToString("N"), "RabiRouteHost.exe"));
                check(actual.InspectTask() == ElevatedTaskState.Missing,
                    "real Task Scheduler reports a missing task without treating it as an elevation failure");
            }
            catch (Exception error)
            {
                check(false, "missing Task Scheduler task: " + error.GetType().Name);
            }
        }
        check(VersionHostCoreLoader.CoreArguments(new[] { "--elevated-task" }).Length == 0,
            "bootstrap consumes its task marker before invoking the Core startup parser");
        var command = new[] { "--command", "status", "--json" };
        check(VersionHostCoreLoader.CoreArguments(command).SequenceEqual(command),
            "bootstrap preserves Core control command arguments");
        var invalid = new[] { "--elevated-task", "--unknown" };
        check(VersionHostCoreLoader.CoreArguments(invalid).SequenceEqual(invalid),
            "bootstrap does not hide unsupported argument combinations");
        var ready = new Driver { Task = ElevatedTaskState.Ready };
        check(!new ReadOnlyHostStatusResult(true, "{\"ok\":true,\"state\":\"stopped\"}").IsRunning,
            "successful stopped status does not bypass first-start elevation");
        check(new ReadOnlyHostStatusResult(true, "{\"ok\":true,\"state\":\"starting\"}").IsRunning,
            "a starting Host is reused without another elevation prompt");
        check(HostElevation.Decide(ready) == ElevationResult.HandedOff && ready.Starts == 1 && ready.Prompts == 0,
            "existing verified task starts without UAC");
        var missing = new Driver { Approved = true };
        check(HostElevation.Decide(missing) == ElevationResult.HandedOff && missing.Prompts == 1,
            "missing task requests one foreground registration");
        var declined = new Driver();
        check(HostElevation.Decide(declined) == ElevationResult.Degraded && declined.Prompts == 1 && declined.Starts == 0,
            "declined UAC continues without privilege or a retry loop");
        var elevated = new Driver { Elevated = true, Task = ElevatedTaskState.Ready };
        check(HostElevation.Decide(elevated) == ElevationResult.Continue && elevated.Starts == 0 && elevated.Prompts == 0,
            "task-launched elevated Host does not recursively invoke its own task");
        var foreign = new Driver { Task = ElevatedTaskState.Foreign };
        check(HostElevation.Decide(foreign) == ElevationResult.Degraded && foreign.Prompts == 0,
            "foreign task is neither executed nor overwritten");
        var limitedTask = new Driver { Task = ElevatedTaskState.Ready };
        check(HostElevation.Decide(limitedTask, taskInvocation: true) == ElevationResult.Degraded && limitedTask.Starts == 0 && limitedTask.Prompts == 0,
            "a task that no longer obtains elevation falls back instead of recursively launching itself");
    }

    private sealed class Driver : IHostElevationDriver
    {
        public bool Elevated { get; init; }
        public ElevatedTaskState Task { get; init; }
        public bool Approved { get; init; }
        public int Starts { get; private set; }
        public int Prompts { get; private set; }
        public bool IsElevated => Elevated;
        public ElevatedTaskState InspectTask() => Task;
        public void RegisterTask() { }
        public void StartTask() => Starts++;
        public bool RequestRegistration() { Prompts++; return Approved; }
    }
}
