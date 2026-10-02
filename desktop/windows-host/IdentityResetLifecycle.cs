using System.Text;
using System.Text.Json;
using System.Security.Cryptography;

namespace RabiRoute.WindowsHost;

internal sealed record IdentityResetRequest(string OperationId, string ExpectedGuid);
internal sealed record IdentityResetReceipt(string OperationId, string OldGuid, string NewGuid, string Outcome);
internal sealed record IdentityResetStatus(int SchemaVersion, string OperationId, string State, string OldGuid, string? NewGuid = null, string? Message = null);

// The Host owns the stopped-generation boundary. DeviceIdentityOwner remains the
// only writer of the identity, its journal, private backups and transaction receipt.
internal sealed class IdentityResetLifecycle
{
    internal const string Command = "reset-instance-id";
    internal const int MaximumRequestBytes = 4096;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly string _packageRoot;
    private readonly string _stateRoot;
    private readonly HostLog _log;
    private readonly string _activePath;

    internal IdentityResetLifecycle(string packageRoot, string stateRoot, HostLog log)
    {
        _packageRoot = Path.GetFullPath(packageRoot);
        _stateRoot = Path.GetFullPath(stateRoot);
        _log = log;
        _activePath = Path.Combine(_stateRoot, "host", "identity-reset-active.json");
    }

    internal static JsonElement ReadRequest(string? filename)
    {
        if (string.IsNullOrWhiteSpace(filename) || !Path.IsPathFullyQualified(filename) || !LocalRuntimePath.IsLocal(filename))
            throw new InvalidDataException("Identity reset requires an absolute local request-file path.");
        RequireRegularPath(filename);
        using var stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is <= 0 or > MaximumRequestBytes) throw new InvalidDataException("Identity reset request size is invalid.");
        using var document = JsonDocument.Parse(stream);
        ParseRequest(document.RootElement);
        return document.RootElement.Clone();
    }

    internal static IdentityResetRequest ParseRequest(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Identity reset request must be an object.");
        var fields = value.EnumerateObject().ToArray();
        if (fields.Length != 2 || fields.Count(field => field.Name == "operationId") != 1 || fields.Count(field => field.Name == "expectedGuid") != 1)
            throw new InvalidDataException("Identity reset request has unexpected or duplicate fields.");
        var operationId = StringField(value, "operationId");
        var expectedGuid = StringField(value, "expectedGuid");
        if (!IsUuid(operationId) || !IsUuid(expectedGuid)) throw new InvalidDataException("Identity reset requires UUID identities.");
        return new(operationId!, expectedGuid!);
    }

    internal static bool IsUuid(string? value) => value is not null && Guid.TryParseExact(value, "D", out var guid) && guid != Guid.Empty;

    internal IdentityResetRequest? ReadPendingRequest()
    {
        IdentityResetRequest? active = null;
        if (File.Exists(_activePath))
        {
            using var document = ReadBoundedDocument(_activePath, MaximumRequestBytes);
            if (document.RootElement.GetProperty("schemaVersion").GetInt32() != 1) throw new InvalidDataException("Identity reset recovery marker is invalid.");
            active = new(StringField(document.RootElement, "operationId")!, StringField(document.RootElement, "expectedGuid")!);
            ValidateIdentities(active);
        }
        var journalPath = Path.Combine(_stateRoot, "data", "rabilink", "identity-reset-pending.json");
        if (!File.Exists(journalPath)) return active;
        using var journal = ReadBoundedDocument(journalPath, 16 * 1024);
        if (journal.RootElement.GetProperty("schemaVersion").GetInt32() != 1) throw new InvalidDataException("Identity reset recovery journal is invalid.");
        var pending = new IdentityResetRequest(StringField(journal.RootElement, "operationId")!, StringField(journal.RootElement, "oldGuid")!);
        ValidateIdentities(pending);
        if (active is not null && active != pending) throw new InvalidDataException("Identity reset recovery ownership does not match.");
        return pending;
    }

    internal void Queue(IdentityResetRequest request)
    {
        ValidateIdentities(request);
        var pending = ReadPendingRequest();
        if (pending is not null && pending != request) throw new InvalidDataException("Another identity reset still requires recovery.");
        var priorStatusPath = StatusPath(request);
        if (File.Exists(priorStatusPath))
        {
            using var prior = ReadBoundedDocument(priorStatusPath, MaximumRequestBytes);
            if (StringField(prior.RootElement, "operationId") != request.OperationId || StringField(prior.RootElement, "oldGuid") != request.ExpectedGuid)
                throw new InvalidDataException("Identity reset operation conflicts with its saved receipt.");
        }
        WriteDurable(_activePath, new { schemaVersion = 1, operationId = request.OperationId, expectedGuid = request.ExpectedGuid });
        WriteStatus(request, "queued");
    }

    internal void WriteStatus(IdentityResetRequest request, string state, IdentityResetReceipt? receipt = null, string? message = null) =>
        WriteDurable(StatusPath(request), new IdentityResetStatus(1, request.OperationId, state, request.ExpectedGuid, receipt?.NewGuid, message));

    internal void Complete(IdentityResetRequest request, IdentityResetReceipt receipt)
    {
        WriteStatus(request, receipt.Outcome, receipt);
        RemoveActive(request);
    }

    internal void RejectUnstartedQueue(IdentityResetRequest request)
    {
        if (File.Exists(Path.Combine(_stateRoot, "data", "rabilink", "identity-reset-pending.json"))) return;
        if (ReadPendingRequest() != request) return;
        WriteStatus(request, "failed", message: "queue_not_accepted");
        RemoveActive(request);
    }

    internal void RemoveActive(IdentityResetRequest request)
    {
        if (!File.Exists(_activePath)) return;
        var pending = ReadPendingRequest();
        if (pending != request) throw new InvalidDataException("Identity reset recovery marker ownership changed.");
        File.Delete(_activePath);
    }

    internal async Task<IdentityResetReceipt> RunOfflineAsync(IdentityResetRequest request, bool recover, CancellationToken cancellationToken)
    {
        ValidateIdentities(request);
        var directory = OperationDirectory(request);
        EnsureDirectory(directory);
        var leasePath = Path.Combine(directory, $".offline-lease-{Guid.NewGuid():N}.json");
        try
        {
            WriteDurable(leasePath, new { schemaVersion = 1, stateRoot = _stateRoot, pid = Environment.ProcessId, nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant() });
            return await RunCliAsync(request, leasePath, recover, cancellationToken);
        }
        finally
        {
            if (File.Exists(leasePath)) File.Delete(leasePath);
        }
    }

    internal static IReadOnlyList<string> BuildArguments(string entry, string stateRoot, IdentityResetRequest request, string leasePath, bool recover) =>
        new[] { entry, recover ? "recover" : "reset", "--state-root", stateRoot, "--expected-guid", request.ExpectedGuid, "--operation-id", request.OperationId, "--offline-lease", leasePath };

    private async Task<IdentityResetReceipt> RunCliAsync(IdentityResetRequest request, string leasePath, bool recover, CancellationToken cancellationToken)
    {
        var entry = Path.Combine(_packageRoot, "dist", "manager", "deviceIdentityCli.js");
        RequireRegularPath(entry);
        var node = StableNodeRuntime.Resolve(_packageRoot, _stateRoot);
        var action = recover ? "recover" : "reset";
        var logs = Path.Combine(_stateRoot, "logs", "host", "identity-reset", request.OperationId);
        EnsureDirectory(logs);
        var attempt = $"{action}-{Guid.NewGuid():N}";
        var stdoutPath = Path.Combine(logs, attempt + ".stdout.json");
        var stderrPath = Path.Combine(logs, attempt + ".stderr.txt");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(60));
        using var job = new WindowsJob($"identity-{request.OperationId}-{attempt}");
        using var child = NativeChildProcess.StartSuspendedInJob(job, node, BuildArguments(entry, _stateRoot, request, leasePath, recover), _stateRoot,
            new Dictionary<string, string?>
            {
                ["NODE_OPTIONS"] = null,
                ["NODE_PATH"] = null,
                ["RABIROUTE_HOST_CONTROL_TOKEN"] = null,
                ["RABIROUTE_HOST_EXECUTABLE"] = null,
                ["RABIROUTE_HOSTED"] = null,
                ["RABIROUTE_APPLICATION_GENERATION_ID"] = null,
                ["RABIROUTE_PACKAGE_ROOT"] = _packageRoot,
                ["RABIROUTE_STATE_ROOT"] = _stateRoot
            });
        _log.Write($"identity operationId={request.OperationId} purpose=offline-instance-identity-{action} pid={child.ProcessId} parentPid={Environment.ProcessId} source=Host-serialized-lifecycle stdout={stdoutPath} stderr={stderrPath}");
        var stdout = CaptureOutputAsync(child.StandardOutput, stdoutPath, timeout.Token);
        var stderr = CaptureOutputAsync(child.StandardError, stderrPath, timeout.Token);
        try
        {
            var exitCode = await child.WaitForExitAsync(timeout.Token);
            var output = await stdout;
            await stderr;
            _log.Write($"identity operationId={request.OperationId} action={action} pid={child.ProcessId} exitCode={exitCode}");
            using var document = JsonDocument.Parse(output);
            if (exitCode != 0 || !document.RootElement.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True)
                throw new InvalidDataException("Offline identity owner did not confirm completion.");
            return ParseReceipt(document.RootElement.GetProperty("receipt"), request);
        }
        finally
        {
            // Closing a Job kills all descendants. Observe both readers before
            // releasing the lease, including timeout/output-limit failure paths.
            if (!child.HasExited || job.MemberProcessIds().Count != 0) job.Terminate(1);
            await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            try { await Task.WhenAll(stdout, stderr); } catch (OperationCanceledException) { } catch (InvalidDataException) { }
        }
    }

    internal static IdentityResetReceipt ParseReceipt(JsonElement value, IdentityResetRequest request)
    {
        var operationId = StringField(value, "operationId");
        var oldGuid = StringField(value, "oldGuid");
        var newGuid = StringField(value, "newGuid");
        var outcome = StringField(value, "outcome");
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("schemaVersion", out var version) || version.GetInt32() != 1
            || operationId != request.OperationId || oldGuid != request.ExpectedGuid || !IsUuid(newGuid) || (outcome == "committed" && newGuid == oldGuid)
            || !DateTimeOffset.TryParse(StringField(value, "completedAt"), out _)
            || outcome is not ("committed" or "rolled_back")) throw new InvalidDataException("Offline identity receipt could not be validated.");
        return new(operationId!, oldGuid!, newGuid!, outcome!);
    }

    private static async Task<string> CaptureOutputAsync(StreamReader reader, string filename, CancellationToken cancellationToken)
    {
        using var file = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        await using var writer = new StreamWriter(file, new UTF8Encoding(false), leaveOpen: true);
        var output = new StringBuilder();
        var buffer = new char[4096];
        while (true)
        {
            var received = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (received == 0) break;
            if (output.Length + received > 64 * 1024) throw new InvalidDataException("Offline identity owner output exceeded its limit.");
            output.Append(buffer, 0, received);
            await writer.WriteAsync(buffer.AsMemory(0, received), cancellationToken);
        }
        await writer.FlushAsync(cancellationToken);
        file.Flush(flushToDisk: true);
        return output.ToString();
    }

    private string OperationDirectory(IdentityResetRequest request) => Path.Combine(_stateRoot, "data", "rabilink", "identity-resets", request.OperationId);
    private string StatusPath(IdentityResetRequest request) => Path.Combine(OperationDirectory(request), "host-status.json");
    private static string? StringField(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
    private static void ValidateIdentities(IdentityResetRequest request)
    {
        if (!IsUuid(request.OperationId) || !IsUuid(request.ExpectedGuid)) throw new InvalidDataException("Identity reset requires UUID identities.");
    }

    private static JsonDocument ReadBoundedDocument(string filename, int maximumBytes)
    {
        RequireRegularPath(filename);
        using var stream = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is <= 0 || stream.Length > maximumBytes) throw new InvalidDataException("Identity reset state size is invalid.");
        return JsonDocument.Parse(stream);
    }

    private static void WriteDurable(string filename, object value)
    {
        EnsureDirectory(Path.GetDirectoryName(filename)!);
        if (File.Exists(filename)) RequireRegularPath(filename);
        var temporary = filename + $".{Guid.NewGuid():N}.pending";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, value, JsonOptions);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, filename, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void EnsureDirectory(string directory)
    {
        RequireRegularPath(directory);
        Directory.CreateDirectory(directory);
        RequireRegularPath(directory);
    }

    private static void RequireRegularPath(string filename)
    {
        var current = Path.GetFullPath(filename);
        while (!string.IsNullOrWhiteSpace(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Identity reset paths must not contain reparse points.");
            current = Path.GetDirectoryName(current);
        }
    }
}
