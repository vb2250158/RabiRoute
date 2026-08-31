using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace RabiRoute.WindowsBootstrap;

internal sealed record ValidatedReleasePayload(string CoreAssemblyPath);

internal static class ReleasePayloadValidator
{
    private static readonly CompareInfo EnglishPathCompareInfo = CultureInfo.GetCultureInfo("en-US").CompareInfo;
    private static readonly IComparer<string> EnglishPathComparer = Comparer<string>.Create(
        (left, right) => EnglishPathCompareInfo.Compare(left, right, CompareOptions.None));
    private static readonly HashSet<string> PrivateTopLevelNames = new(
        new[] { "data", "logs", "recordings", "transcripts" },
        StringComparer.OrdinalIgnoreCase);

    internal static ValidatedReleasePayload Validate(
        string packageRoot,
        ReleasePointer pointer,
        ReleaseManifest manifest)
    {
        ValidateIdentity(pointer, manifest);
        var manifestEntries = ValidateManifestEntries(manifest);
        var actualEntries = ReadActualPayload(packageRoot);
        ValidateExactFileSet(manifestEntries, actualEntries);
        ValidateTopLevelEntries(manifest, manifestEntries);

        var actualPayloadSha256 = ComputePayloadSha256(manifestEntries);
        if (!string.Equals(actualPayloadSha256, manifest.PayloadSha256, StringComparison.Ordinal)
            || !string.Equals(actualPayloadSha256, pointer.PayloadSha256, StringComparison.Ordinal))
            throw new InvalidDataException("RabiRoute payload hash does not match the release files.");

        var expectedReleaseId = $"{manifest.PackageVersion}-{actualPayloadSha256[..12]}";
        if (!string.Equals(expectedReleaseId, manifest.ReleaseId, StringComparison.Ordinal)
            || !string.Equals(expectedReleaseId, pointer.ReleaseId, StringComparison.Ordinal))
            throw new InvalidDataException("RabiRoute releaseId does not match packageVersion and payloadSha256.");

        var coreEntry = manifestEntries.SingleOrDefault(entry =>
            entry.Path.Equals(ReleasePointerResolver.CoreAssemblyFileName, StringComparison.Ordinal));
        if (coreEntry is null)
            throw new InvalidDataException("RabiRoute release manifest does not contain the Host core.");
        return new ValidatedReleasePayload(
            Path.Combine(packageRoot, ReleasePointerResolver.CoreAssemblyFileName));
    }

    internal static bool IsCanonicalSha256(string? value) =>
        value is { Length: 64 }
        && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    internal static bool IsSafeSingleSegment(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value is "." or ".."
            || !string.Equals(value, value.Trim(), StringComparison.Ordinal)
            || value.EndsWith('.')
            || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            return false;
        return true;
    }

    internal static string ComputePayloadSha256(IEnumerable<ReleaseManifestFile> entries)
    {
        var canonicalPayload = string.Concat(entries
            .OrderBy(entry => entry.Path, EnglishPathComparer)
            .Select(entry => $"{entry.Path}\0{entry.Size}\0{entry.Sha256}\n"));
        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonicalPayload))).ToLowerInvariant();
    }

    private static void ValidateIdentity(ReleasePointer pointer, ReleaseManifest manifest)
    {
        if (manifest.SchemaVersion != 1
            || !string.Equals(manifest.AppId, "io.rabiroute.windows", StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(manifest.PackageVersion)
            || !string.Equals(manifest.PackageVersion, manifest.PackageVersion.Trim(), StringComparison.Ordinal)
            || !string.Equals(manifest.ReleaseId, pointer.ReleaseId, StringComparison.Ordinal)
            || !IsCanonicalSha256(manifest.PayloadSha256)
            || !string.Equals(manifest.PayloadSha256, pointer.PayloadSha256, StringComparison.Ordinal)
            || manifest.TopLevelEntries is null
            || manifest.Files is null)
            throw new InvalidDataException("RabiRoute release manifest identity does not match current.json.");
    }

    private static IReadOnlyList<ReleaseManifestFile> ValidateManifestEntries(ReleaseManifest manifest)
    {
        if (manifest.Files.Count == 0)
            throw new InvalidDataException("RabiRoute release manifest contains no payload files.");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in manifest.Files)
        {
            if (entry is null
                || !IsCanonicalReleasePath(entry.Path)
                || entry.Path.Equals(ReleasePointerResolver.ManifestFileName, StringComparison.OrdinalIgnoreCase)
                || entry.Size < 0
                || !IsCanonicalSha256(entry.Sha256))
                throw new InvalidDataException("RabiRoute release manifest contains an invalid file entry.");
            if (!seen.Add(entry.Path))
                throw new InvalidDataException($"RabiRoute release manifest contains a duplicate path: {entry.Path}");
        }

        var sorted = manifest.Files.OrderBy(entry => entry.Path, EnglishPathComparer).ToArray();
        if (!manifest.Files.Select(entry => entry.Path).SequenceEqual(sorted.Select(entry => entry.Path), StringComparer.Ordinal))
            throw new InvalidDataException("RabiRoute release manifest file order is not canonical.");
        return sorted;
    }

    private static IReadOnlyDictionary<string, ReleaseManifestFile> ReadActualPayload(string packageRoot)
    {
        var files = new Dictionary<string, ReleaseManifestFile>(StringComparer.OrdinalIgnoreCase);
        EnumerateDirectory(packageRoot, packageRoot, files);
        return files;
    }

    private static void EnumerateDirectory(
        string packageRoot,
        string currentDirectory,
        IDictionary<string, ReleaseManifestFile> files)
    {
        foreach (var entryPath in Directory.EnumerateFileSystemEntries(currentDirectory))
        {
            var attributes = File.GetAttributes(entryPath);
            var releasePath = Path.GetRelativePath(packageRoot, entryPath)
                .Replace(Path.DirectorySeparatorChar, '/');
            if (!IsCanonicalReleasePath(releasePath))
                throw new InvalidDataException($"RabiRoute release contains an unsafe path: {releasePath}");
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException($"RabiRoute release contains a reparse point: {releasePath}");
            if ((attributes & FileAttributes.Directory) != 0)
            {
                EnumerateDirectory(packageRoot, entryPath, files);
                continue;
            }
            if (!File.Exists(entryPath))
                throw new InvalidDataException($"RabiRoute release contains an unsupported entry: {releasePath}");
            if (releasePath.Equals(ReleasePointerResolver.ManifestFileName, StringComparison.Ordinal))
                continue;

            var actual = ReadRegularFile(entryPath, releasePath);
            if (!files.TryAdd(releasePath, actual))
                throw new InvalidDataException($"RabiRoute release contains colliding file paths: {releasePath}");
        }
    }

    private static ReleaseManifestFile ReadRegularFile(string filePath, string releasePath)
    {
        using var stream = new FileStream(
            filePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            1024 * 1024,
            FileOptions.SequentialScan);
        var size = stream.Length;
        var sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        var finalAttributes = File.GetAttributes(filePath);
        if ((finalAttributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0
            || new FileInfo(filePath).Length != size)
            throw new InvalidDataException($"RabiRoute release file changed during validation: {releasePath}");
        return new ReleaseManifestFile(releasePath, size, sha256);
    }

    private static void ValidateExactFileSet(
        IReadOnlyList<ReleaseManifestFile> manifestEntries,
        IReadOnlyDictionary<string, ReleaseManifestFile> actualEntries)
    {
        if (manifestEntries.Count != actualEntries.Count)
            throw new InvalidDataException("RabiRoute release file set does not match the manifest.");
        foreach (var expected in manifestEntries)
        {
            if (!actualEntries.TryGetValue(expected.Path, out var actual)
                || !string.Equals(actual.Path, expected.Path, StringComparison.Ordinal)
                || actual.Size != expected.Size
                || !string.Equals(actual.Sha256, expected.Sha256, StringComparison.Ordinal))
                throw new InvalidDataException($"RabiRoute release file does not match the manifest: {expected.Path}");
        }
    }

    private static void ValidateTopLevelEntries(
        ReleaseManifest manifest,
        IReadOnlyList<ReleaseManifestFile> manifestEntries)
    {
        var expected = manifestEntries
            .Select(entry => entry.Path.Split('/', 2)[0])
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, EnglishPathComparer)
            .ToArray();
        if (!manifest.TopLevelEntries.SequenceEqual(expected, StringComparer.Ordinal))
            throw new InvalidDataException("RabiRoute release manifest topLevelEntries are not canonical.");
    }

    private static bool IsCanonicalReleasePath(string? releasePath)
    {
        if (string.IsNullOrWhiteSpace(releasePath)
            || releasePath.StartsWith('/')
            || releasePath.EndsWith('/')
            || releasePath.Contains('\\')
            || !string.Equals(releasePath, releasePath.Trim(), StringComparison.Ordinal))
            return false;
        var segments = releasePath.Split('/');
        if (segments.Any(segment => !IsSafeSingleSegment(segment))) return false;
        return !PrivateTopLevelNames.Contains(segments[0]);
    }
}
