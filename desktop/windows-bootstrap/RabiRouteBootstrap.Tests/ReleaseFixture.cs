using RabiRoute.WindowsBootstrap;
using RabiRoute.WindowsHost;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed class ReleaseFixture : IDisposable
{
    private const string PackageVersion = "0.3.0";
    private static readonly IComparer<string> EnglishPathComparer = Comparer<string>.Create(
        (left, right) => CultureInfo.GetCultureInfo("en-US").CompareInfo.Compare(
            left, right, CompareOptions.None));

    internal ReleaseFixture()
    {
        InstallRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-bootstrap-{Guid.NewGuid():N}");
        var stagingRoot = Path.Combine(InstallRoot, "staging");
        Directory.CreateDirectory(Path.Combine(stagingRoot, "dist"));
        Directory.CreateDirectory(Path.Combine(stagingRoot, "desktop-runtime"));
        File.Copy(typeof(HostEntry).Assembly.Location, Path.Combine(stagingRoot, ReleasePointerResolver.CoreAssemblyFileName));
        File.WriteAllText(Path.Combine(stagingRoot, "node.exe"), "node");
        File.WriteAllText(Path.Combine(stagingRoot, "dist", "manager.js"), "manager");
        File.WriteAllText(Path.Combine(stagingRoot, "desktop-runtime", "main.py"), "tray");

        var stagingEntries = ReadEntries(stagingRoot);
        var payloadSha256 = PayloadSha256(stagingEntries);
        ReleaseId = $"{PackageVersion}-{payloadSha256[..12]}";
        PackageRoot = Path.GetFullPath(Path.Combine(InstallRoot, "versions", ReleaseId));
        Directory.CreateDirectory(Path.GetDirectoryName(PackageRoot)!);
        Directory.Move(stagingRoot, PackageRoot);
        WriteValidMetadata();
    }

    internal string InstallRoot { get; }
    internal string PackageRoot { get; }
    internal string ReleaseId { get; }

    internal string FilePath(string releasePath) =>
        Path.Combine(PackageRoot, releasePath.Replace('/', Path.DirectorySeparatorChar));

    internal void WriteValidMetadata()
    {
        var entries = ReadEntries(PackageRoot);
        var payloadSha256 = PayloadSha256(entries);
        if (!ReleaseId.Equals($"{PackageVersion}-{payloadSha256[..12]}", StringComparison.Ordinal))
            throw new InvalidOperationException("Fixture payload identity changed unexpectedly.");
        var topLevelEntries = entries
            .Select(entry => entry.Path.Split('/', 2)[0])
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, EnglishPathComparer)
            .ToArray();
        File.WriteAllText(
            Path.Combine(PackageRoot, ReleasePointerResolver.ManifestFileName),
            JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                appId = "io.rabiroute.windows",
                packageVersion = PackageVersion,
                releaseId = ReleaseId,
                payloadSha256,
                topLevelEntries,
                files = entries
            }));
        File.WriteAllText(
            Path.Combine(InstallRoot, ReleasePointerResolver.PointerFileName),
            JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                appId = "io.rabiroute.windows",
                releaseId = ReleaseId,
                versionPath = $"versions/{ReleaseId}",
                payloadSha256
            }));
    }

    internal void EditManifest(Action<JsonObject> edit)
    {
        var path = Path.Combine(PackageRoot, ReleasePointerResolver.ManifestFileName);
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        edit(root);
        File.WriteAllText(path, root.ToJsonString());
    }

    internal void EditPointer(Action<JsonObject> edit)
    {
        var path = Path.Combine(InstallRoot, ReleasePointerResolver.PointerFileName);
        var root = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        edit(root);
        File.WriteAllText(path, root.ToJsonString());
    }

    internal static bool TryCreateDirectoryReparsePoint(string linkPath, string targetPath)
    {
        try
        {
            Directory.CreateSymbolicLink(linkPath, targetPath);
            return true;
        }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList = { "/d", "/c", "mklink", "/J", linkPath, targetPath }
            });
            process?.WaitForExit();
            return process?.ExitCode == 0 && Directory.Exists(linkPath)
                && (File.GetAttributes(linkPath) & FileAttributes.ReparsePoint) != 0;
        }
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(InstallRoot, recursive: true);
        }
        catch (UnauthorizedAccessException) when (File.Exists(FilePath(ReleasePointerResolver.CoreAssemblyFileName)))
        {
            // The production load context intentionally holds the core mapping
            // until this short-lived test process exits.
        }
    }

    private static FixtureFile[] ReadEntries(string root)
    {
        return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Where(path => !Path.GetRelativePath(root, path)
                .Equals(ReleasePointerResolver.ManifestFileName, StringComparison.Ordinal))
            .Select(path => new FixtureFile(
                Path.GetRelativePath(root, path).Replace(Path.DirectorySeparatorChar, '/'),
                new FileInfo(path).Length,
                Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant()))
            .OrderBy(entry => entry.Path, EnglishPathComparer)
            .ToArray();
    }

    private static string PayloadSha256(IEnumerable<FixtureFile> entries)
    {
        var canonical = string.Concat(entries.Select(entry =>
            $"{entry.Path}\0{entry.Size}\0{entry.Sha256}\n"));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    private sealed record FixtureFile(
        [property: System.Text.Json.Serialization.JsonPropertyName("path")] string Path,
        [property: System.Text.Json.Serialization.JsonPropertyName("size")] long Size,
        [property: System.Text.Json.Serialization.JsonPropertyName("sha256")] string Sha256);
}
