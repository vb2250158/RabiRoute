using System.Text.Json;
using System.Text.Json.Serialization;

namespace RabiRoute.WindowsBootstrap;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ReleasePointer(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("appId")] string AppId,
    [property: JsonPropertyName("releaseId")] string ReleaseId,
    [property: JsonPropertyName("versionPath")] string VersionPath,
    [property: JsonPropertyName("payloadSha256")] string PayloadSha256);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ReleaseManifest(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("appId")] string AppId,
    [property: JsonPropertyName("packageVersion")] string PackageVersion,
    [property: JsonPropertyName("releaseId")] string ReleaseId,
    [property: JsonPropertyName("payloadSha256")] string PayloadSha256,
    [property: JsonPropertyName("topLevelEntries")] IReadOnlyList<string> TopLevelEntries,
    [property: JsonPropertyName("files")] IReadOnlyList<ReleaseManifestFile> Files);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ReleaseManifestFile(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("sha256")] string Sha256);

internal sealed record ResolvedRelease(
    string InstallRoot,
    string PackageRoot,
    string StateRoot,
    string CoreAssemblyPath,
    string? ReleaseId,
    bool FlatSelfTest);

internal static class ReleasePointerResolver
{
    internal const string PointerFileName = "current.json";
    internal const string ManifestFileName = "release-manifest.json";
    internal const string CoreAssemblyFileName = "RabiRouteHost.Core.dll";

    internal static ResolvedRelease Resolve(string installRoot, bool allowFlatSelfTest)
    {
        var fullInstallRoot = Path.GetFullPath(installRoot);
        RequireRegularDirectory(fullInstallRoot, "install root");
        var pointerPath = Path.Combine(fullInstallRoot, PointerFileName);
        if (!File.Exists(pointerPath))
        {
            if (!allowFlatSelfTest)
                throw new InvalidDataException("RabiRoute current.json is missing; refusing an unversioned runtime start.");
            var adjacentCore = Path.Combine(fullInstallRoot, CoreAssemblyFileName);
            RequireRegularFile(adjacentCore, "flat self-test Host core");
            return new ResolvedRelease(
                fullInstallRoot,
                fullInstallRoot,
                fullInstallRoot,
                adjacentCore,
                null,
                true);
        }

        RequireRegularFile(pointerPath, "release pointer");
        ReleasePointer pointer;
        try
        {
            pointer = JsonSerializer.Deserialize<ReleasePointer>(
                File.ReadAllBytes(pointerPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = false })
                ?? throw new InvalidDataException("RabiRoute current.json is empty.");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("RabiRoute current.json is invalid.", error);
        }

        if (pointer.SchemaVersion != 1 || !string.Equals(pointer.AppId, "io.rabiroute.windows", StringComparison.Ordinal))
            throw new InvalidDataException("RabiRoute current.json identity is unsupported.");
        if (!ReleasePayloadValidator.IsSafeSingleSegment(pointer.ReleaseId) || pointer.ReleaseId.Length > 160)
            throw new InvalidDataException("RabiRoute current.json releaseId is invalid.");
        if (!ReleasePayloadValidator.IsCanonicalSha256(pointer.PayloadSha256))
            throw new InvalidDataException("RabiRoute current.json payloadSha256 is invalid.");

        var expectedVersionPath = $"versions/{pointer.ReleaseId}";
        if (!string.Equals(pointer.VersionPath, expectedVersionPath, StringComparison.Ordinal))
            throw new InvalidDataException("RabiRoute current.json versionPath must be versions/<releaseId>.");

        var versionsRoot = Path.GetFullPath(Path.Combine(fullInstallRoot, "versions"));
        var packageRoot = Path.GetFullPath(Path.Combine(fullInstallRoot, "versions", pointer.ReleaseId));
        if (!IsStrictChild(versionsRoot, packageRoot))
            throw new InvalidDataException("RabiRoute current.json versionPath escapes the versions directory.");
        RequireRegularDirectory(versionsRoot, "versions root");
        RequireRegularDirectory(packageRoot, "version package root");

        var manifestPath = Path.Combine(packageRoot, ManifestFileName);
        RequireRegularFile(manifestPath, "release manifest");
        ReleaseManifest manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<ReleaseManifest>(
                File.ReadAllBytes(manifestPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = false })
                ?? throw new InvalidDataException("RabiRoute release manifest is empty.");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("RabiRoute release manifest is invalid.", error);
        }
        var validatedPayload = ReleasePayloadValidator.Validate(packageRoot, pointer, manifest);
        return new ResolvedRelease(
            fullInstallRoot,
            packageRoot,
            fullInstallRoot,
            validatedPayload.CoreAssemblyPath,
            pointer.ReleaseId,
            false);
    }

    private static bool IsStrictChild(string root, string candidate)
    {
        var relative = Path.GetRelativePath(root, candidate);
        return !Path.IsPathRooted(relative) && relative != "." &&
            !relative.Equals("..", StringComparison.Ordinal) &&
            !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal);
    }

    private static void RequireRegularDirectory(string path, string label)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"RabiRoute {label} is missing: {path}");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"RabiRoute {label} must not be a reparse point.");
    }

    private static void RequireRegularFile(string path, string label)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"RabiRoute {label} is missing.", path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"RabiRoute {label} must not be a reparse point.");
    }
}
