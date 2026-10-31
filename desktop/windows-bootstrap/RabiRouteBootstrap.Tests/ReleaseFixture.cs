using RabiRoute.WindowsBootstrap;
using RabiRoute.WindowsHost;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed class ReleaseFixture : IDisposable
{
    internal const string ManifestFileName = "release-manifest.json";
    internal ReleaseFixture()
    {
        InstallRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-bootstrap-{Guid.NewGuid():N}");
        ReleaseId = "fixture-local-version";
        PackageRoot = Path.GetFullPath(Path.Combine(InstallRoot, "versions", ReleaseId));
        Directory.CreateDirectory(Path.Combine(PackageRoot, "dist"));
        Directory.CreateDirectory(Path.Combine(PackageRoot, "desktop-runtime"));
        File.Copy(typeof(HostEntry).Assembly.Location, FilePath(ReleasePointerResolver.CoreAssemblyFileName));
        File.WriteAllText(FilePath("node.exe"), "fixture node");
        File.WriteAllText(FilePath("dist/manager.js"), "fixture manager");
        File.WriteAllText(FilePath("desktop-runtime/main.py"), "fixture tray");
        WritePointer(); WriteManifest();
    }
    internal string InstallRoot { get; }
    internal string PackageRoot { get; }
    internal string ReleaseId { get; }
    internal string FilePath(string relative) => Path.Combine(PackageRoot, relative.Replace('/', Path.DirectorySeparatorChar));
    internal void WritePointer() => File.WriteAllText(Path.Combine(InstallRoot, ReleasePointerResolver.PointerFileName),
        JsonSerializer.Serialize(new { schemaVersion = 1, appId = "io.rabiroute.windows", releaseId = ReleaseId,
            versionPath = $"versions/{ReleaseId}", payloadSha256 = "unused build metadata" }));
    internal void WriteManifest() => File.WriteAllText(FilePath(ManifestFileName),
        JsonSerializer.Serialize(new { schemaVersion = 1, releaseId = "unrelated-old-build", files = Array.Empty<object>() }));
    internal void EditPointer(Action<JsonObject> edit)
    {
        var filename = Path.Combine(InstallRoot, ReleasePointerResolver.PointerFileName);
        var value = JsonNode.Parse(File.ReadAllText(filename))!.AsObject(); edit(value);
        File.WriteAllText(filename, value.ToJsonString());
    }
    internal static bool TryCreateDirectoryReparsePoint(string linkPath, string targetPath)
    {
        try { Directory.CreateSymbolicLink(linkPath, targetPath); return true; }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                ArgumentList = { "/d", "/c", "mklink", "/J", linkPath, targetPath }
            });
            process?.WaitForExit();
            return process?.ExitCode == 0 && Directory.Exists(linkPath)
                && (File.GetAttributes(linkPath) & FileAttributes.ReparsePoint) != 0;
        }
    }
    public void Dispose()
    {
        try { Directory.Delete(InstallRoot, recursive: true); }
        catch (UnauthorizedAccessException) when (File.Exists(FilePath(ReleasePointerResolver.CoreAssemblyFileName)))
        {
            // The production non-collectible loader holds its fixture DLL until this test process exits.
        }
    }
}
