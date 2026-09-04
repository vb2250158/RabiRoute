using RabiRoute.WindowsBootstrap;
using System.Text.Json;
using System.Text.Json.Nodes;

var failures = new List<string>();
void Check(bool condition, string message)
{
    if (!condition) failures.Add(message);
}

var nodeLocaleFixture = new[]
{
    new ReleaseManifestFile("z.txt", 1, new string('0', 64)),
    new ReleaseManifestFile("ä.txt", 2, new string('1', 64)),
    new ReleaseManifestFile("a.txt", 3, new string('2', 64)),
    new ReleaseManifestFile("A.txt", 4, new string('3', 64)),
    new ReleaseManifestFile("10.txt", 5, new string('4', 64)),
    new ReleaseManifestFile("2.txt", 6, new string('5', 64))
};
var nodeLocalePayloadSha256 = ReleasePayloadValidator.ComputePayloadSha256(nodeLocaleFixture);
Check(
    nodeLocalePayloadSha256 == "e51fbba16bfa8319825f070ea87269a1155553c62a2cc5dc54f29d01f4744279",
    $"payload canonicalization matches Node localeCompare(path, 'en') ordering; actual={nodeLocalePayloadSha256}");
Check(
    ReadOnlyHostStatusProbe.IsStatusInvocation(new[] { "--command", "status", "--json" }),
    "read-only status is recognized before immutable payload validation");
Check(
    !ReadOnlyHostStatusProbe.IsStatusInvocation(new[] { "--command", "restart", "--json" }),
    "restart remains on the fully validated lifecycle path");
Check(
    !ReadOnlyHostStatusProbe.IsStatusInvocation(new[] { "--command", "status", "--allow-unfenced-quit" }),
    "status fast path rejects unrelated lifecycle flags");
Check(
    JsonSerializer.Serialize(new ReadOnlyHostStatusRequest("status", null)) ==
        "{\"Command\":\"status\",\"ApplicationGenerationId\":null}",
    "read-only status uses the Host protocol's strict property names");
Check(
    ReadOnlyHostStatusProbe.NormalizeResponseJson(
        "{\"Ok\":true,\"State\":\"healthy\",\"ManagerBaseUrl\":\"http://127.0.0.1:1234\"}") ==
        "{\"ok\":true,\"state\":\"healthy\",\"managerBaseUrl\":\"http://127.0.0.1:1234\"}",
    "read-only status preserves the public camelCase JSON contract");

void ExpectReject(ReleaseFixture fixture, Action mutation, Action restore, string message)
{
    mutation();
    try
    {
        ReleasePointerResolver.Resolve(fixture.InstallRoot, allowFlatSelfTest: false);
        failures.Add(message);
    }
    catch (Exception error) when (error is InvalidDataException or FileNotFoundException or DirectoryNotFoundException)
    {
    }
    finally
    {
        restore();
    }
    Check(ReleasePointerResolver.Resolve(fixture.InstallRoot, allowFlatSelfTest: false).ReleaseId == fixture.ReleaseId,
        $"fixture is valid after restoring: {message}");
}

using var fixture = new ReleaseFixture();
var resolved = ReleasePointerResolver.Resolve(fixture.InstallRoot, allowFlatSelfTest: false);
Check(resolved.PackageRoot == fixture.PackageRoot, "pointer resolves the exact version package root");
Check(resolved.StateRoot == fixture.InstallRoot, "runtime state remains at the stable install root");

foreach (var releasePath in new[]
{
    "node.exe",
    "dist/manager.js",
    "desktop-runtime/main.py",
    ReleasePointerResolver.CoreAssemblyFileName
})
{
    var filePath = fixture.FilePath(releasePath);
    var original = File.ReadAllBytes(filePath);
    ExpectReject(
        fixture,
        () => File.AppendAllText(filePath, "tamper"),
        () => File.WriteAllBytes(filePath, original),
        $"tampered payload file is rejected: {releasePath}");
}

var extraPath = fixture.FilePath("dist/extra.js");
ExpectReject(
    fixture,
    () => File.WriteAllText(extraPath, "extra"),
    () => File.Delete(extraPath),
    "an extra payload file is rejected");

ExpectReject(
    fixture,
    () => fixture.EditManifest(root =>
    {
        var files = root["files"]!.AsArray();
        files.Add(files[0]!.DeepClone());
    }),
    fixture.WriteValidMetadata,
    "duplicate manifest paths are rejected");

ExpectReject(
    fixture,
    () => fixture.EditManifest(root => root["files"]![0]!["path"] = "../escape"),
    fixture.WriteValidMetadata,
    "manifest traversal paths are rejected");

ExpectReject(
    fixture,
    () => fixture.EditManifest(root => root["files"]![0]!["path"] = "dist\\manager.js"),
    fixture.WriteValidMetadata,
    "manifest backslash paths are rejected");

ExpectReject(
    fixture,
    () => fixture.EditManifest(root => root["files"]!.AsArray().RemoveAt(0)),
    fixture.WriteValidMetadata,
    "a payload file omitted from the manifest is rejected");

ExpectReject(
    fixture,
    () => fixture.EditManifest(root => root["topLevelEntries"] = new JsonArray("wrong")),
    fixture.WriteValidMetadata,
    "non-canonical topLevelEntries are rejected");

ExpectReject(
    fixture,
    () => fixture.EditManifest(root => root["packageVersion"] = "0.3.1"),
    fixture.WriteValidMetadata,
    "releaseId must derive from packageVersion and payload hash");

ExpectReject(
    fixture,
    () => fixture.EditPointer(root => root["payloadSha256"] = new string('0', 64)),
    fixture.WriteValidMetadata,
    "pointer payload hash mismatch is rejected");

var linkedPath = fixture.FilePath("dist/linked-runtime");
var externalTarget = Path.Combine(fixture.InstallRoot, "reparse-target");
Directory.CreateDirectory(externalTarget);
File.WriteAllText(Path.Combine(externalTarget, "outside.js"), "outside");
if (ReleaseFixture.TryCreateDirectoryReparsePoint(linkedPath, externalTarget))
{
    ExpectReject(
        fixture,
        () => { },
        () => Directory.Delete(linkedPath),
        "an inner release reparse point is rejected");
}
else
{
    failures.Add("test environment could not create the required inner reparse-point fixture");
}

resolved = ReleasePointerResolver.Resolve(fixture.InstallRoot, allowFlatSelfTest: false);
var beforePid = Environment.ProcessId;
Check(await VersionHostCoreLoader.LoadAndRunAsync(resolved, new[] { "--self-test" }) == 0,
    "bootstrap invokes the fully validated version Host core self-test");
Check(Environment.ProcessId == beforePid, "bootstrap loads Host core in the same process");

var pointerOnlyRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-bootstrap-pointer-{Guid.NewGuid():N}");
Directory.CreateDirectory(pointerOnlyRoot);
try
{
    File.WriteAllText(Path.Combine(pointerOnlyRoot, "current.json"),
        "{\"schemaVersion\":1,\"appId\":\"io.rabiroute.windows\",\"releaseId\":\"escape\",\"versionPath\":\"versions/../escape\",\"payloadSha256\":\"" +
        new string('0', 64) + "\"}");
    try
    {
        ReleasePointerResolver.Resolve(pointerOnlyRoot, allowFlatSelfTest: false);
        failures.Add("pointer traversal outside versions is rejected");
    }
    catch (InvalidDataException) { }
}
finally
{
    Directory.Delete(pointerOnlyRoot, recursive: true);
}

var missingPointerRoot = Path.Combine(Path.GetTempPath(), $"rabiroute-bootstrap-missing-{Guid.NewGuid():N}");
Directory.CreateDirectory(missingPointerRoot);
try
{
    try
    {
        ReleasePointerResolver.Resolve(missingPointerRoot, allowFlatSelfTest: false);
        failures.Add("normal startup without current.json is rejected");
    }
    catch (InvalidDataException) { }
}
finally
{
    Directory.Delete(missingPointerRoot, recursive: true);
}

if (failures.Count > 0)
{
    foreach (var failure in failures) Console.Error.WriteLine($"FAIL: {failure}");
    return 1;
}

Console.WriteLine("RabiRoute bootstrap tests passed.");
return 0;
