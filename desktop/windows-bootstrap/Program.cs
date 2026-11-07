namespace RabiRoute.WindowsBootstrap;

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        await using var startup = await StartupPresentation.TryStartAsync(args);
        try
        {
            if (ReadOnlyHostStatusProbe.IsStatusInvocation(args))
            {
                RabiRoute.WindowsHost.HostTimeouts.Load(Path.GetFullPath(AppContext.BaseDirectory));
                var response = await ReadOnlyHostStatusProbe.QueryAsync();
                if (args.Contains("--json", StringComparer.OrdinalIgnoreCase))
                {
                    BootstrapConsole.AttachToParent();
                    Console.WriteLine(response.Json);
                }
                return response.Ok ? 0 : 2;
            }
            var installRoot = Path.GetFullPath(AppContext.BaseDirectory);
            var selfTest = args.Contains("--self-test", StringComparer.OrdinalIgnoreCase);
            var release = ReleasePointerResolver.Resolve(installRoot, allowFlatSelfTest: selfTest);
            startup?.ApplyTheme(release.StateRoot);
            if (args.Length == 4 && args[0] == "--command" && args[1] == "elevated-autostart" && args[2] == "--enabled" && args[3] is "true" or "false")
            {
                using var elevation = new WindowsHostElevationDriver(Path.Combine(installRoot, "RabiRouteHost.exe"));
                elevation.SetAutostart(args[3] == "true");
                return 0;
            }
            if (!selfTest && !args.Contains("--command", StringComparer.OrdinalIgnoreCase))
            {
                if (args.Length == 0 && (await ReadOnlyHostStatusProbe.QueryAsync()).IsRunning)
                {
                    var activationExitCode = await VersionHostCoreLoader.LoadAndRunAsync(release, args);
                    if (startup is not null) await startup.FollowActivationAsync(activationExitCode);
                    return activationExitCode;
                }
                var elevated = false;
                ElevationResult? elevationResult = null;
                try
                {
                    using var elevation = new WindowsHostElevationDriver(Path.Combine(installRoot, "RabiRouteHost.exe"));
                    if (args.Length == 2 && args[0] == "--register-elevated-host")
                        return elevation.RegisterForCurrentOwner(args[1]) ? 0 : 77;
                    elevated = elevation.IsElevated;
                    elevationResult = HostElevation.Decide(elevation, args.Length == 1 && args[0] == "--elevated-task");
                }
                catch (Exception error) when (error is System.Runtime.InteropServices.COMException or System.ComponentModel.Win32Exception or UnauthorizedAccessException or InvalidOperationException)
                {
                    if (args.Contains("--register-elevated-host", StringComparer.Ordinal)) return 77;
                }
                if (elevationResult == ElevationResult.HandedOff)
                {
                    if (startup is not null)
                    {
                        startup.Present("正在连接 RabiRoute 宿主…");
                        await startup.WaitForHandoffAsync();
                    }
                    return 0;
                }
                Environment.SetEnvironmentVariable("RABIROUTE_HOST_ELEVATED", elevated ? "1" : "0");
                try
                {
                    var directory = Path.Combine(release.StateRoot, "data", "runtime");
                    Directory.CreateDirectory(directory);
                    File.WriteAllText(Path.Combine(directory, "privilege-status.json"), System.Text.Json.JsonSerializer.Serialize(new {
                        state = elevated ? "administrator" : "limited",
                        message = elevated ? "Rabi Host 已以管理员权限运行。" : "管理员授权未完成：HA 虚拟机、Core 自动恢复及端口转发受限，其他功能继续运行。"
                    }));
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            }
            startup?.Present("正在启动 RabiRoute 宿主…");
            var running = VersionHostCoreLoader.LoadAndRunAsync(release, args);
            startup?.ObserveHost();
            var exitCode = await running;
            if (startup is not null)
            {
                if (exitCode == 0) startup.Complete();
                else await startup.ShowFailureAsync($"RabiRoute 宿主已退出（{exitCode}）。请查看宿主日志。");
            }
            return exitCode;
        }
        catch (Exception error)
        {
            if (startup is not null) await startup.ShowFailureAsync(error.Message);
            if (args.Contains("--json", StringComparer.OrdinalIgnoreCase))
            {
                BootstrapConsole.AttachToParent();
                Console.Error.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
                {
                    ok = false,
                    state = "release_invalid",
                    message = error.Message
                }));
            }
            return 80;
        }
    }
}
