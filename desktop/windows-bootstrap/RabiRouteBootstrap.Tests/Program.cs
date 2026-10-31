using RabiRoute.WindowsBootstrap;
using System.Text.Json;
using System.Text.Json.Nodes;

var failures = new List<string>();
var checks = 0;
void Check(bool condition, string message) { checks++; if (!condition) failures.Add(message); }
HostElevationTests.Run(Check);
Check(ReadOnlyHostStatusProbe.IsStatusInvocation(new[] { "--command", "status", "--json" }), "status remains a read-only Host query");
Check(!ReadOnlyHostStatusProbe.IsStatusInvocation(new[] { "--command", "restart", "--json" }), "restart uses the selected Core lifecycle owner");
Check(!ReadOnlyHostStatusProbe.IsStatusInvocation(new[] { "--command", "status", "--allow-unfenced-quit" }), "status does not absorb lifecycle flags");
Check(JsonSerializer.Serialize(new ReadOnlyHostStatusRequest("status", null)) == "{\"Command\":\"status\",\"ApplicationGenerationId\":null}", "status retains Host protocol property names");
Check(ReadOnlyHostStatusProbe.NormalizeResponseJson("{\"Ok\":true,\"State\":\"healthy\"}") == "{\"ok\":true,\"state\":\"healthy\"}", "status keeps public camelCase output");
using var fixture = new ReleaseFixture();
void ExpectAccept(Action mutation, Action restore, string message)
{
    try
    {
        mutation(); var value = ReleasePointerResolver.Resolve(fixture.InstallRoot, false);
        Check(value.PackageRoot == fixture.PackageRoot && value.CoreAssemblyPath == fixture.FilePath(ReleasePointerResolver.CoreAssemblyFileName), message);
    }
    catch (Exception error) { failures.Add($"{message}: {error.Message}"); }
    finally { restore(); }
}
void ExpectReject(Action mutation, Action restore, string message)
{
    try { mutation(); ReleasePointerResolver.Resolve(fixture.InstallRoot, false); failures.Add(message); }
    catch (Exception error) when (error is InvalidDataException or FileNotFoundException or DirectoryNotFoundException) { checks++; }
    finally { restore(); }
}
var resolved = ReleasePointerResolver.Resolve(fixture.InstallRoot, false);
Check(resolved.StateRoot == fixture.InstallRoot && resolved.PackageRoot == fixture.PackageRoot, "selected code and stable state roots remain separate");
var manifest = fixture.FilePath(ReleaseFixture.ManifestFileName);
ExpectAccept(() => File.Delete(manifest), fixture.WriteManifest, "missing manifest does not block startup");
ExpectAccept(() => File.WriteAllText(manifest, "{malformed"), fixture.WriteManifest, "malformed manifest is not parsed during startup");
ExpectAccept(() => File.WriteAllText(manifest, "{\"schemaVersion\":999,\"releaseId\":\"old\",\"files\":[{\"path\":\"../outside\"}]}"), fixture.WriteManifest, "stale or mismatched manifest is irrelevant to startup");
ExpectAccept(() => { File.Delete(manifest); Directory.CreateDirectory(manifest); },
    () => { Directory.Delete(manifest); fixture.WriteManifest(); }, "startup does not open or stat the manifest");
var extra = fixture.FilePath("dist/extra-unlisted.js");
ExpectAccept(() => File.WriteAllText(extra, "extra"), () => File.Delete(extra), "extra payload files do not block startup");
foreach (var relative in new[] { "node.exe", "dist/manager.js", "desktop-runtime/main.py", ReleasePointerResolver.CoreAssemblyFileName })
{
    var file = fixture.FilePath(relative); var original = File.ReadAllBytes(file);
    ExpectAccept(() => File.AppendAllText(file, "changed"), () => File.WriteAllBytes(file, original), $"startup does not hash modified payload: {relative}");
}
using (var held = new FileStream(fixture.FilePath("node.exe"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
    Check(ReleasePointerResolver.Resolve(fixture.InstallRoot, false).PackageRoot == fixture.PackageRoot, "startup does not open unrelated payload files");
ExpectAccept(() => fixture.EditPointer(value => value.Remove("payloadSha256")), fixture.WritePointer, "pointer payload digest is optional build metadata");
ExpectAccept(() => fixture.EditPointer(value => { value["payloadSha256"] = new JsonObject { ["obsolete"] = true }; value["extraMetadata"] = "ignored"; }), fixture.WritePointer, "obsolete digest shape and extra pointer metadata do not gate startup");
ExpectReject(() => fixture.EditPointer(value => value["versionPath"] = "versions/../escape"), fixture.WritePointer, "version path traversal stays outside the owner boundary");
ExpectReject(() => fixture.EditPointer(value => value["releaseId"] = "../escape"), fixture.WritePointer, "releaseId must identify one local directory");
ExpectReject(() => fixture.EditPointer(value => value["appId"] = "another.application"), fixture.WritePointer, "pointer still identifies this application owner");
var core = fixture.FilePath(ReleasePointerResolver.CoreAssemblyFileName);
var savedCore = core + ".saved";
ExpectReject(() => File.Move(core, savedCore), () => File.Move(savedCore, core), "the actual required Core DLL must exist");
var linked = fixture.FilePath("dist/unrelated-link");
var target = Path.Combine(fixture.InstallRoot, "fixture-external");
Directory.CreateDirectory(target);
if (ReleaseFixture.TryCreateDirectoryReparsePoint(linked, target))
    ExpectAccept(() => { }, () => Directory.Delete(linked), "unrelated payload links are not recursively inspected");
else failures.Add("Cannot create the required temporary junction fixture.");
var savedPackage = Path.Combine(fixture.InstallRoot, "saved-package");
Directory.Move(fixture.PackageRoot, savedPackage);
if (ReleaseFixture.TryCreateDirectoryReparsePoint(fixture.PackageRoot, savedPackage))
    ExpectReject(() => { }, () => { Directory.Delete(fixture.PackageRoot); Directory.Move(savedPackage, fixture.PackageRoot); }, "selected version directory must not be a reparse point");
else { Directory.Move(savedPackage, fixture.PackageRoot); failures.Add("Cannot create the required version junction fixture."); }
resolved = ReleasePointerResolver.Resolve(fixture.InstallRoot, false); File.Delete(manifest);
var beforePid = Environment.ProcessId;
Check(await VersionHostCoreLoader.LoadAndRunAsync(resolved, new[] { "--self-test" }) == 0, "actual loader invokes the fixture Core without a manifest");
Check(Environment.ProcessId == beforePid, "selected Core loads in the same process");
var invocation = JsonNode.Parse(File.ReadAllText(Path.Combine(fixture.InstallRoot, "fixture-core-invocation.json")))!;
Check(invocation["packageRoot"]!.GetValue<string>() == fixture.PackageRoot && invocation["stateRoot"]!.GetValue<string>() == fixture.InstallRoot, "loader passes exact package and stable state roots to Core ABI");
Check(invocation["args"]![0]!.GetValue<string>() == "--self-test", "loader preserves original arguments");
Check(await VersionHostCoreLoader.LoadAndRunAsync(resolved, new[] { "--fixture-result" }) == 17, "loader preserves Core result");
var flat = Path.Combine(Path.GetTempPath(), $"rabiroute-bootstrap-flat-{Guid.NewGuid():N}"); Directory.CreateDirectory(flat);
try
{
    File.Copy(core, Path.Combine(flat, ReleasePointerResolver.CoreAssemblyFileName));
    try { ReleasePointerResolver.Resolve(flat, false); failures.Add("Normal startup without a pointer must report the missing selected version."); }
    catch (InvalidDataException) { checks++; }
    var flatRelease = ReleasePointerResolver.Resolve(flat, true);
    Check(flatRelease.FlatSelfTest && flatRelease.PackageRoot == flat && flatRelease.StateRoot == flat, "flat self-test needs no manifest or version inventory");
}
finally { Directory.Delete(flat, recursive: true); }
if (failures.Count > 0) { foreach (var failure in failures) Console.Error.WriteLine($"FAIL: {failure}"); return 1; }
Console.WriteLine($"RabiRoute bootstrap tests passed: {checks} checks; fixture Core only, no Host or Manager started.");
return 0;
