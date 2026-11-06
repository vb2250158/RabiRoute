using System.Diagnostics;
using System.Text.Json;
using RabiRoute.WindowsHost;

internal static class ProcessTreeTests
{
    internal static async Task<int> FixtureAsync(string[] args)
    {
        var directory = args[1];
        if (args[0] == "--tree-leaf")
        {
            File.WriteAllText(Path.Combine(directory, "leaf"), Environment.ProcessId.ToString());
            await Task.Delay(Timeout.Infinite);
            return 0;
        }
        if (args[0] == "--tree-parent")
        {
            var speech = Environment.GetEnvironmentVariable("RABIROUTE_TEST_SPEECH_EXE");
            var leafStart = string.IsNullOrEmpty(speech) ? StartInfo("--tree-leaf", directory)
                : new ProcessStartInfo(speech) { UseShellExecute = false, CreateNoWindow = true };
            if (!string.IsNullOrEmpty(speech))
            {
                leafStart.ArgumentList.Add("-c");
                leafStart.ArgumentList.Add("import os,pathlib,time;pathlib.Path(os.environ['RABIROUTE_TREE_RECEIPT']).write_text(str(os.getpid()));time.sleep(120)");
                leafStart.Environment["RABIROUTE_TREE_RECEIPT"] = Path.Combine(directory, "leaf");
            }
            using var leaf = Process.Start(leafStart)!;
            await WaitUntilAsync(() => File.Exists(Path.Combine(directory, "leaf")));
            if (args[2] == "parent-exit") return 0;
            await Task.Delay(Timeout.Infinite);
            return 0;
        }
        using var job = new WindowsJob($"tree-test-{Guid.NewGuid():N}");
        using var parent = NativeChildProcess.StartSuspendedInJob(job, Environment.ProcessPath!,
            new[] { "--tree-parent", directory, args[2] }, directory, new Dictionary<string, string?>());
        await WaitUntilAsync(() => File.Exists(Path.Combine(directory, "leaf")));
        var leafPid = uint.Parse(File.ReadAllText(Path.Combine(directory, "leaf")));
        await WaitUntilAsync(() => job.MemberProcessIds().Contains(leafPid));
        if (args[2] == "parent-exit") await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        File.WriteAllText(Path.Combine(directory, "ready"), JsonSerializer.Serialize(new {
            parentPid = parent.ProcessId, leafPid, members = job.MemberProcessIds(), parentExited = parent.HasExited
        }));
        await Console.In.ReadLineAsync();
        job.Terminate(0);
        await WaitUntilAsync(() => job.MemberProcessIds().Count == 0);
        await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        return 0;
    }

    internal static async Task RunAsync(Action<bool, string> check)
    {
        foreach (var mode in new[] { "normal", "owner-crash", "parent-exit" })
        {
            var directory = Path.Combine(Path.GetTempPath(), $"rabiroute-tree-{Guid.NewGuid():N}");
            Directory.CreateDirectory(directory);
            Process? owner = null;
            uint[] descendants = Array.Empty<uint>();
            try
            {
                var start = StartInfo("--tree-owner", directory, mode);
                start.RedirectStandardInput = true;
                owner = Process.Start(start)!;
                await WaitUntilAsync(() => File.Exists(Path.Combine(directory, "ready")) || owner.HasExited);
                if (owner.HasExited) throw new InvalidOperationException($"Tree fixture exited early: {owner.ExitCode}");
                using var receipt = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "ready")));
                var root = receipt.RootElement;
                var leaf = root.GetProperty("leafPid").GetUInt32();
                descendants = root.GetProperty("members").EnumerateArray().Select(item => item.GetUInt32()).ToArray();
                check(descendants.Contains(leaf), $"{mode}: grandchild belongs to the same Host Job");
                if (mode == "parent-exit")
                    check(root.GetProperty("parentExited").GetBoolean(), "grandchild stays owned after its immediate parent exits");
                if (mode == "owner-crash") owner.Kill();
                else { await owner.StandardInput.WriteLineAsync("stop"); await owner.StandardInput.FlushAsync(); }
                await owner.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
                await WaitUntilAsync(() => descendants.All(pid => !Running(pid)));
                check(descendants.All(pid => !Running(pid)), $"{mode}: every owned descendant actually exits");
                if (mode != "owner-crash") check(owner.ExitCode == 0, $"{mode}: normal owner exit is successful");
            }
            finally
            {
                if (owner is not null)
                {
                    if (!owner.HasExited) { owner.Kill(); await owner.WaitForExitAsync(); }
                    owner.Dispose();
                }
                // Cleanup is restricted to this fixture's recorded process IDs.
                foreach (var pid in descendants)
                    if (Running(pid)) { using var process = Process.GetProcessById((int)pid); process.Kill(); await process.WaitForExitAsync(); }
                Directory.Delete(directory, true);
            }
        }
    }

    private static ProcessStartInfo StartInfo(params string[] args)
    {
        var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        return info;
    }
    private static bool Running(uint pid)
    {
        try { using var process = Process.GetProcessById((int)pid); return !process.HasExited; }
        catch (ArgumentException) { return false; }
    }
    private static async Task WaitUntilAsync(Func<bool> ready)
    {
        var deadline = Stopwatch.StartNew();
        while (!ready())
        {
            if (deadline.Elapsed > TimeSpan.FromSeconds(15)) throw new TimeoutException("Process tree did not reach the expected state");
            await Task.Delay(25);
        }
    }
}
