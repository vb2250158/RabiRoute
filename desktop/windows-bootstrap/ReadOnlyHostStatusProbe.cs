using System.Buffers;
using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace RabiRoute.WindowsBootstrap;

/** A read-only status query may ask the running Host directly; lifecycle paths still validate the release payload. */
internal static class ReadOnlyHostStatusProbe
{
    private const int MaximumMessageBytes = 64 * 1024;

    internal static bool IsStatusInvocation(string[] args)
    {
        var statusSeen = false;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index].Equals("--json", StringComparison.OrdinalIgnoreCase)) continue;
            if (args[index].Equals("--command", StringComparison.OrdinalIgnoreCase)
                && !statusSeen
                && index + 1 < args.Length
                && args[index + 1].Equals("status", StringComparison.OrdinalIgnoreCase))
            {
                statusSeen = true;
                index += 1;
                continue;
            }
            return false;
        }
        return statusSeen;
    }

    internal static Task<ReadOnlyHostStatusResult> QueryAsync(CancellationToken cancellationToken = default) =>
        QueryAsync(PipeName(), RabiRoute.WindowsHost.HostTimeouts.Get("host.status.probe", TimeSpan.FromSeconds(2)), cancellationToken);

    internal static async Task<ReadOnlyHostStatusResult> QueryAsync(string pipeName, TimeSpan deadline, CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(deadline);
        await using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        try
        {
            await client.ConnectAsync(timeout.Token);
            await WriteAsync(client, new ReadOnlyHostStatusRequest("status", null), timeout.Token);
            return new ReadOnlyHostStatusResult(true, NormalizeResponseJson(await ReadJsonAsync(client, timeout.Token)));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return Unknown("Host status query timed out."); }
        catch (IOException) { return Unknown("Host status transport is unavailable."); }
        catch (UnauthorizedAccessException) { return Unknown("Host status access was denied."); }
        catch (JsonException) { return Unknown("Host status response contains invalid JSON."); }
        catch (InvalidDataException) { return Unknown("Host status response is invalid."); }
    }

    private static ReadOnlyHostStatusResult Unknown(string message) => new(false,
        JsonSerializer.Serialize(new { ok = false, state = "unknown", message }), ReceivedResponse: false);

    private static string PipeName()
    {
        var identity = WindowsIdentity.GetCurrent();
        var source = identity.User?.Value ?? identity.Name;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(source));
        return $"RabiRoute.Host.{Convert.ToHexString(hash.AsSpan(0, 8))}";
    }

    private static async Task WriteAsync<T>(Stream stream, T value, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length > MaximumMessageBytes) throw new InvalidDataException("Host control message is too large.");
        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    private static async Task<string> ReadJsonAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[sizeof(int)];
        await stream.ReadExactlyAsync(header, cancellationToken);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > MaximumMessageBytes) throw new InvalidDataException("Invalid Host control message length.");
        var payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken);
        using var document = JsonDocument.Parse(payload);
        return document.RootElement.GetRawText();
    }

    internal static string NormalizeResponseJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Host control response must be a JSON object.");
        var buffer = new ArrayBufferWriter<byte>();
        var hasStatus = false;
        var hasOutcome = false;
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in document.RootElement.EnumerateObject())
            {
                var name = property.Name.Length == 0
                    ? property.Name
                    : char.ToLowerInvariant(property.Name[0]) + property.Name[1..];
                if (name == "ok") hasOutcome = property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False;
                if (name == "state") hasStatus = property.Value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(property.Value.GetString());
                writer.WritePropertyName(name);
                property.Value.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        if (!hasOutcome || !hasStatus) throw new InvalidDataException("Host control response must contain an outcome and state.");
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }
}

internal sealed record ReadOnlyHostStatusResult(bool Ok, string Json, bool ReceivedResponse = true)
{
    internal bool IsRunning
    {
        get
        {
            if (!Ok) return false;
            using var document = JsonDocument.Parse(Json);
            var root = document.RootElement;
            return root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
                root.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(state.GetString()) && state.GetString() != "stopped";
        }
    }
}

internal sealed record ReadOnlyHostStatusRequest(string Command, string? ApplicationGenerationId);
