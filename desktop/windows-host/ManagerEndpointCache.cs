using System.Text.Json;

namespace RabiRoute.WindowsHost;

// A public discovery hint, rebuilt by the lifecycle owner. Never contains control credentials.
internal sealed class ManagerEndpointCache
{
    private readonly string _path;
    private string? _lastJson;

    internal ManagerEndpointCache(string path) => _path = path;

    internal void Publish(LifecyclePublication publication)
    {
        var json = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            state = publication.State,
            hostPid = Environment.ProcessId,
            managerBaseUrl = publication.ManagerBaseUrl,
            applicationGenerationId = publication.ApplicationGenerationId,
            managerInstanceId = publication.ManagerInstanceId
        });
        if (json == _lastJson) return;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temporary = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, json);
            File.Move(temporary, _path, overwrite: true);
            _lastJson = json;
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
