using System.Text.Json;

namespace RabiRoute.WindowsHost;

// Test-only ABI fixture: no Host mutex, process launcher, network, or Manager.
public static class HostEntry
{
    public static async Task<int> RunAsync(string[] args, string packageRoot, string stateRoot)
    {
        await File.WriteAllTextAsync(Path.Combine(stateRoot, "fixture-core-invocation.json"),
            JsonSerializer.Serialize(new { args, packageRoot, stateRoot }));
        return args.SequenceEqual(new[] { "--self-test" }) ? 0 : 17;
    }
}
