using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal static class ManagerEndpointCacheTests
{
    internal static void Run(Action<bool, string> check)
    {
        var root = Path.Combine(Path.GetTempPath(), "rabi-endpoint-test-" + Guid.NewGuid().ToString("N"));
        var path = Path.Combine(root, "manager-endpoint.json");
        try
        {
            var cache = new ManagerEndpointCache(path);
            cache.Publish(new LifecyclePublication("healthy", "generation-a", "generation-a", "manager-a", "http://127.0.0.1:54321"));
            using (var ready = JsonDocument.Parse(File.ReadAllText(path)))
            {
                check(ready.RootElement.GetProperty("applicationGenerationId").GetString() == "generation-a", "endpoint cache publishes admitted identity");
                check(ready.RootElement.GetProperty("schemaVersion").GetInt32() == 1, "endpoint cache has a versioned schema");
            }
            cache.Publish(new LifecyclePublication("stopping", "generation-a"));
            using var stopped = JsonDocument.Parse(File.ReadAllText(path));
            check(stopped.RootElement.GetProperty("managerBaseUrl").ValueKind == JsonValueKind.Null, "stopping invalidates cached endpoint");
            cache.Publish(new LifecyclePublication("degraded", "generation-b", "generation-b", "manager-b", "http://127.0.0.1:54322"));
            using var replacement = JsonDocument.Parse(File.ReadAllText(path));
            check(replacement.RootElement.GetProperty("managerInstanceId").GetString() == "manager-b", "replacement generation updates the cache");
            check(Directory.GetFiles(root).Length == 1, "endpoint publication leaves no partial files");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }
    }
}
