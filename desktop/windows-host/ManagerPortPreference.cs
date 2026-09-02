using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal sealed record ManagerPortPreferenceDocument(int SchemaVersion, int ManagerPort);

internal static class ManagerPortPreference
{
    private const int SchemaVersion = 1;
    private const string DirectoryName = "host";
    private const string FileName = "manager-port-preference.json";

    internal static string ResolveStartupPolicy(string stateRoot, HostLog log)
    {
        var preferredPort = TryRead(stateRoot, log);
        return preferredPort is int port ? $"prefer:{port}" : "auto";
    }

    internal static void SaveSuccessfulEndpoint(string stateRoot, string baseUrl, HostLog log)
    {
        try
        {
            if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var endpoint) ||
                endpoint.Scheme != Uri.UriSchemeHttp ||
                !System.Net.IPAddress.TryParse(endpoint.Host, out var address) ||
                !System.Net.IPAddress.IsLoopback(address) ||
                endpoint.Port is < 1 or > 65_535)
            {
                log.Write("Manager port preference was not updated because READY did not contain a valid loopback endpoint.");
                return;
            }

            var (directory, path) = ResolveCachePath(stateRoot);
            EnsureRegularDirectory(directory);
            if (File.Exists(path)) RequireRegularFile(path);

            var temporary = Path.Combine(directory, $".{FileName}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
            try
            {
                var document = new ManagerPortPreferenceDocument(SchemaVersion, endpoint.Port);
                File.WriteAllText(temporary, JsonSerializer.Serialize(document));
                File.Move(temporary, path, overwrite: true);
                RequireRegularFile(path);
                log.Write($"Manager port preference saved port={endpoint.Port}");
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }
        }
        catch (Exception exception)
        {
            // This is a convenience cache. A filesystem problem must never block a healthy generation.
            log.Write($"Manager port preference was not updated: {exception.Message}");
        }
    }

    private static int? TryRead(string stateRoot, HostLog log)
    {
        try
        {
            var (directory, path) = ResolveCachePath(stateRoot);
            if (!Directory.Exists(directory) || !File.Exists(path)) return null;
            RequireRegularDirectory(directory);
            RequireRegularFile(path);
            var document = JsonSerializer.Deserialize<ManagerPortPreferenceDocument>(File.ReadAllText(path));
            if (document is null || document.SchemaVersion != SchemaVersion || document.ManagerPort is < 1 or > 65_535)
            {
                log.Write("Manager port preference was ignored because its content is invalid.");
                return null;
            }
            log.Write($"Manager port preference loaded port={document.ManagerPort}");
            return document.ManagerPort;
        }
        catch (Exception exception)
        {
            // A stale, corrupted, or unavailable cache falls back to normal OS allocation.
            log.Write($"Manager port preference was ignored: {exception.Message}");
            return null;
        }
    }

    private static (string Directory, string Path) ResolveCachePath(string stateRoot)
    {
        var root = Path.GetFullPath(stateRoot);
        var directory = Path.GetFullPath(Path.Combine(root, DirectoryName));
        var rootedDirectory = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!directory.StartsWith(rootedDirectory, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The Manager port preference path escaped the RabiRoute state root.");
        return (directory, Path.Combine(directory, FileName));
    }

    private static void EnsureRegularDirectory(string path)
    {
        if (Directory.Exists(path))
        {
            RequireRegularDirectory(path);
            return;
        }
        Directory.CreateDirectory(path);
        RequireRegularDirectory(path);
    }

    private static void RequireRegularDirectory(string path)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"Manager port preference directory is missing: {path}");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("The Manager port preference directory must not be a reparse point.");
    }

    private static void RequireRegularFile(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("Manager port preference file is missing.", path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("The Manager port preference file must not be a reparse point.");
    }
}
