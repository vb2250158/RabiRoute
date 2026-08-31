namespace RabiRoute.WindowsBootstrap;

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        try
        {
            var installRoot = Path.GetFullPath(AppContext.BaseDirectory);
            var selfTest = args.Contains("--self-test", StringComparer.OrdinalIgnoreCase);
            var release = ReleasePointerResolver.Resolve(installRoot, allowFlatSelfTest: selfTest);
            return await VersionHostCoreLoader.LoadAndRunAsync(release, args);
        }
        catch (Exception error)
        {
            if (args.Contains("--json", StringComparer.OrdinalIgnoreCase))
            {
                BootstrapConsole.AttachToParent();
                Console.Error.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
                {
                    ok = false,
                    state = "release_invalid",
                    message = error.Message
                }));
            }
            return 80;
        }
    }
}
