using System.Security.Cryptography;
using System.Text.Json;
using RabiRoute.WindowsHost;

internal static class TrayReleaseTests
{
    internal static void Run(Action<bool, string> check)
    {
        var state = Directory.CreateTempSubdirectory("rabiroute-tray-release-").FullName;
        try
        {
            var payload = new[] { "main.py", "python/python.exe", "python/pythonw.exe" };
            var bytes = new byte[] { 1, 2, 3 };
            var manifest = JsonSerializer.SerializeToUtf8Bytes(new
            {
                schemaVersion = 1,
                files = payload.Select(path => new { path, size = bytes.Length, sha256 = Hash(bytes) })
            });
            var release = Hash(manifest);
            var root = Path.Combine(state, "tray-releases", release);
            Directory.CreateDirectory(Path.Combine(root, "python"));
            foreach (var file in payload) File.WriteAllBytes(Path.Combine(root, file), bytes);
            File.WriteAllBytes(Path.Combine(root, "tray-release.json"), manifest);

            check(TrayRelease.ReadSelection(state) == TrayRelease.Bundled, "The built-in Tray is the initial selection");
            check(TrayRelease.Resolve(state, state, release, CancellationToken.None).Root == root,
                "The manifest digest resolves only its verified complete payload");
            TrayRelease.SaveSelection(state, release);
            check(TrayRelease.ReadSelection(state) == release, "The selected Tray survives Host restart");
            var tampered = Path.Combine(root, "main.py");
            File.WriteAllBytes(tampered, new byte[] { 4, 5, 6 });
            check(RejectsRelease(), "Same-size payload changes fail hash verification");
            File.WriteAllBytes(tampered, bytes);
            File.WriteAllText(Path.Combine(root, "unexpected.py"), "");
            check(RejectsRelease(), "Unmanifested payload files are rejected");

            bool RejectsRelease()
            {
                try { _ = TrayRelease.Resolve(state, state, release, CancellationToken.None); return false; }
                catch (InvalidDataException) { return true; }
            }
        }
        finally { Directory.Delete(state, true); }
    }

    private static string Hash(byte[] content) => Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();
}
