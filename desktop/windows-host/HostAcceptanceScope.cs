namespace RabiRoute.WindowsHost;

/// <summary>Validates an explicitly created, disposable Host acceptance fixture.</summary>
internal static class HostAcceptanceScope
{
    internal const string MarkerName = ".rabiroute-acceptance";
    internal const string MarkerContent = "RabiRoute isolated acceptance fixture v1";

    internal static (string Mutex, string Pipe) Validate(string stateRoot, bool starting)
    {
        if (string.IsNullOrWhiteSpace(stateRoot) || !Path.IsPathFullyQualified(stateRoot) || !LocalRuntimePath.IsLocal(stateRoot))
            throw new InvalidDataException("Acceptance requires an absolute local fixture root.");
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(stateRoot));
        var configuredParent = Environment.GetEnvironmentVariable("RABIROUTE_ACCEPTANCE_TEMP_PARENT");
        if (configuredParent is not null && (!Path.IsPathFullyQualified(configuredParent) || !LocalRuntimePath.IsLocal(configuredParent)))
            throw new InvalidDataException("Acceptance temporary parent must be an absolute local path.");
        var temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(configuredParent ?? Path.GetTempPath()));
        var relative = Path.GetRelativePath(temp, root);
        if (relative is "." or ".." || Path.IsPathFullyQualified(relative) || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidDataException("Acceptance fixture must be a child of the temporary directory.");
        for (string? current = root; current is not null; current = Path.GetDirectoryName(current))
        {
            if (!Directory.Exists(current) || (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Acceptance fixture directories must exist and cannot be links.");
        }
        var marker = Path.Combine(root, MarkerName);
        if (!File.Exists(marker) || (File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0 || File.ReadAllText(marker) != MarkerContent)
            throw new InvalidDataException("Acceptance fixture marker is missing or invalid.");
        if (starting && (File.Exists(Path.Combine(root, ".env")) || Directory.Exists(Path.Combine(root, "data"))))
            throw new InvalidDataException("Acceptance startup requires a fresh fixture without runtime data or credentials.");
        return HostIdentity.AcceptanceNames(root);
    }
}
