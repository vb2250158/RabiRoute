using System.Text;
using RabiRoute.WindowsHost;

internal static class EnvironmentBlockTests
{
    internal static void Run(Action<bool, string> check)
    {
        var inherited = new KeyValuePair<string, string?>[]
        {
            new("no_proxy", "lower.example"),
            new("NO_PROXY", "upper.example"),
            new("Path", "first"),
            new("PATH", "second"),
            new("UNICODE", "中文=值"),
            new("EMPTY", "")
        };
        try
        {
            var bytes = NativeChildProcess.BuildEnvironmentBlock(inherited, new Dictionary<string, string?>());
            var text = Encoding.Unicode.GetString(bytes);
            var entries = text.Split('\0', StringSplitOptions.RemoveEmptyEntries);
            check(text.EndsWith("\0\0", StringComparison.Ordinal), "environment block has a UTF-16 double-NUL terminator");
            check(entries.Length == 4, "case-variant inherited variables collapse to one Windows key");
            check(entries.Contains("no_proxy=upper.example"), "last inherited value wins without changing retained key spelling");
            check(entries.Contains("Path=second"), "deduplication is generic, not proxy-specific");
            check(entries.Contains("UNICODE=中文=值") && entries.Contains("EMPTY="), "Unicode, equals signs and empty values survive serialization");
            check(entries.SequenceEqual(entries.OrderBy(entry => entry.Split('=')[0], StringComparer.OrdinalIgnoreCase)), "environment block is sorted by Windows key");

            var overrides = new Dictionary<string, string?> { ["No_PrOxY"] = "explicit.example", ["pAtH"] = null, ["ADDED"] = "value" };
            var overridden = Encoding.Unicode.GetString(NativeChildProcess.BuildEnvironmentBlock(inherited, overrides));
            check(overridden.Contains("no_proxy=explicit.example\0", StringComparison.Ordinal), "explicit overrides win over all inherited case variants");
            check(!overridden.Contains("Path=", StringComparison.OrdinalIgnoreCase), "null overrides remove all inherited case variants");
            check(overridden.Contains("ADDED=value\0", StringComparison.Ordinal), "new explicit variables are included");
            check(inherited[0].Value == "lower.example" && overrides["pAtH"] is null, "environment inputs remain unchanged");
            check(Encoding.Unicode.GetString(NativeChildProcess.BuildEnvironmentBlock([], new Dictionary<string, string?>())) == "\0\0", "empty environment block remains double-NUL terminated");
            var acceptanceSource = new KeyValuePair<string, string?>[] {
                new("SystemRoot", "C:\\Windows"), new("Path", "C:\\Windows\\System32"),
                new("PRIVATE_TOKEN", "fixture-secret"), new("ROUTE_DIR", "private-routes"),
                new("LOCALAPPDATA", "private-appdata"), new("TEMP", "private-temp") };
            var acceptanceText = Encoding.Unicode.GetString(NativeChildProcess.BuildEnvironmentBlock(
                NativeChildProcess.AcceptanceEnvironment("fixture-root", acceptanceSource), new Dictionary<string, string?>()));
            check(!acceptanceText.Contains("fixture-secret", StringComparison.Ordinal) && !acceptanceText.Contains("private-routes", StringComparison.Ordinal),
                "acceptance children cannot inherit user credentials or route overrides");
            check(!acceptanceText.Contains("private-appdata", StringComparison.Ordinal) && !acceptanceText.Contains("private-temp", StringComparison.Ordinal),
                "acceptance children do not inherit user profile or temporary directories");
            check(acceptanceText.Contains("LOCALAPPDATA=fixture-root\0", StringComparison.OrdinalIgnoreCase)
                && acceptanceText.Contains("SystemRoot=C:\\Windows\0", StringComparison.OrdinalIgnoreCase),
                "acceptance children use fixture-local profile paths and retain the Windows system root");
        }
        catch (Exception exception)
        {
            check(false, $"duplicate inherited environment keys must not prevent child startup: {exception.GetType().Name}");
        }
    }
}
