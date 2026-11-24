using System.Security.Cryptography;
using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal sealed record TrayRelease(string Selection, string Root)
{
    internal const string Bundled = "bundled";
    internal const string Command = "tray-switch";
    private const string ManifestName = "tray-release.json";
    private const string SelectionName = "tray-selection.json";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record Manifest(int SchemaVersion, Entry[] Files);
    private sealed record Entry(string Path, long Size, string Sha256);

    internal static bool IsSelection(string? value) => value == Bundled || IsDigest(value);

    private static bool IsDigest(string? value) =>
        value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static TrayRelease Resolve(string packageRoot, string stateRoot, string selection, CancellationToken cancellationToken)
    {
        if (selection == Bundled) return new(Bundled, Path.Combine(packageRoot, "desktop-runtime"));
        if (!IsDigest(selection)) throw new InvalidDataException("Invalid Tray release digest.");

        var releases = Path.Combine(stateRoot, "tray-releases");
        var root = Path.Combine(releases, selection);
        RejectLink(stateRoot);
        RejectLink(releases);
        RejectLink(root);
        var manifestFile = Path.Combine(root, ManifestName);
        RejectLink(manifestFile);
        var bytes = File.ReadAllBytes(manifestFile);
        if (!MatchesHash(SHA256.HashData(bytes), selection)) throw new InvalidDataException("Tray manifest digest does not match its release id.");
        var manifest = JsonSerializer.Deserialize<Manifest>(bytes, JsonOptions);
        if (manifest is not { SchemaVersion: 1, Files: { Length: > 0 } }) throw new InvalidDataException("Invalid Tray release manifest.");

        var expected = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in manifest.Files)
        {
            if (entry is null || string.IsNullOrWhiteSpace(entry.Path) || entry.Size < 0 || !IsDigest(entry.Sha256) ||
                entry.Path.Split('/').Any(part => part is "" or "." or ".." || part.Contains('\\') || part.Contains(':')) ||
                !expected.TryAdd(entry.Path, entry))
                throw new InvalidDataException("Invalid or duplicate Tray payload entry.");
        }
        foreach (var required in new[] { "main.py", "python/python.exe", "python/pythonw.exe" })
            if (!expected.ContainsKey(required)) throw new InvalidDataException($"Tray release is missing {required}.");
        VerifyDirectory(root, root, expected, cancellationToken);
        if (expected.Count != 0) throw new InvalidDataException("Tray release payload is incomplete.");
        return new(selection, root);
    }

    private static void VerifyDirectory(string root, string directory, Dictionary<string, Entry> expected, CancellationToken cancellationToken)
    {
        foreach (var file in new DirectoryInfo(directory).EnumerateFileSystemInfos())
        {
            cancellationToken.ThrowIfCancellationRequested();
            RejectLink(file.FullName);
            if (file is DirectoryInfo)
            {
                VerifyDirectory(root, file.FullName, expected, cancellationToken);
                continue;
            }
            var relative = Path.GetRelativePath(root, file.FullName).Replace('\\', '/');
            if (relative == ManifestName) continue;
            if (!expected.Remove(relative, out var entry) || !string.Equals(relative, entry.Path, StringComparison.Ordinal))
                throw new InvalidDataException($"Unexpected Tray payload file: {relative}.");
            using var stream = File.OpenRead(file.FullName);
            if (stream.Length != entry.Size || !MatchesHash(SHA256.HashData(stream), entry.Sha256))
                throw new InvalidDataException($"Tray payload hash mismatch: {relative}.");
        }
    }

    private static void RejectLink(string path)
    {
        if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidDataException("Tray releases cannot use linked files or directories.");
    }

    private static bool MatchesHash(byte[] hash, string expected) =>
        string.Equals(Convert.ToHexString(hash), expected, StringComparison.OrdinalIgnoreCase);

    internal static string ReadSelection(string stateRoot)
    {
        var path = Path.Combine(stateRoot, SelectionName);
        if (!File.Exists(path)) return Bundled;
        RejectLink(path);
        var selection = JsonSerializer.Deserialize<string>(File.ReadAllBytes(path));
        return IsSelection(selection) ? selection! : throw new InvalidDataException("Invalid saved Tray release.");
    }

    internal static void SaveSelection(string stateRoot, string selection)
    {
        var path = Path.Combine(stateRoot, SelectionName);
        var pending = path + "." + Guid.NewGuid().ToString("N");
        try
        {
            using (var file = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(file, selection);
                file.Flush(flushToDisk: true);
            }
            File.Move(pending, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(pending)) File.Delete(pending);
        }
    }
}
