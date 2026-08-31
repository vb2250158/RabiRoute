using System.Reflection;
using System.Runtime.Loader;

namespace RabiRoute.WindowsBootstrap;

internal sealed class VersionHostLoadContext : AssemblyLoadContext
{
    private readonly AssemblyDependencyResolver _resolver;

    internal VersionHostLoadContext(string coreAssemblyPath) : base("RabiRoute version Host core", isCollectible: false)
    {
        _resolver = new AssemblyDependencyResolver(coreAssemblyPath);
    }

    protected override Assembly? Load(AssemblyName assemblyName)
    {
        var path = _resolver.ResolveAssemblyToPath(assemblyName);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

internal static class VersionHostCoreLoader
{
    internal static async Task<int> LoadAndRunAsync(ResolvedRelease release, string[] args)
    {
        var context = new VersionHostLoadContext(release.CoreAssemblyPath);
        var assembly = context.LoadFromAssemblyPath(release.CoreAssemblyPath);
        var entryType = assembly.GetType("RabiRoute.WindowsHost.HostEntry", throwOnError: true)
            ?? throw new TypeLoadException("RabiRoute Host core does not expose HostEntry.");
        var method = entryType.GetMethod(
            "RunAsync",
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: new[] { typeof(string[]), typeof(string), typeof(string) },
            modifiers: null)
            ?? throw new MissingMethodException("RabiRoute Host core does not expose HostEntry.RunAsync.");
        var task = method.Invoke(null, new object[] { args, release.PackageRoot, release.StateRoot }) as Task<int>
            ?? throw new InvalidOperationException("RabiRoute HostEntry.RunAsync returned an invalid result.");
        return await task.ConfigureAwait(false);
    }
}
