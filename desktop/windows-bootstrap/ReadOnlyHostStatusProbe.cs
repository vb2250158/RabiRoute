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

    internal static async Task<ReadOnlyHostStatusResult> QueryAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await using var client = new NamedPipeClientStream(".", PipeName(), PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        try
        {
            await client.ConnectAsync(timeout.Token);
            await WriteAsync(client, new ReadOnlyHostStatusRequest("status", null), timeout.Token);
            return new ReadOnlyHostStatusResult(true, NormalizeResponseJson(await ReadJsonAsync(client, timeout.Token)));
        }
        catch (OperationCanceledException) { return Stopped(); }
        catch (IOException) { return Stopped(); }
        catch (UnauthorizedAccessException) { return Stopped(); }
        catch (JsonException) { return Stopped(); }
        catch (InvalidDataException) { return Stopped(); }
    }

    private static ReadOnlyHostStatusResult Stopped() => new(true,
        JsonSerializer.Serialize(new { ok = true, state = "stopped", message = "No Host instance is running." }));

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
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in document.RootElement.EnumerateObject())
            {
                var name = property.Name.Length == 0
                    ? property.Name
                    : char.ToLowerInvariant(property.Name[0]) + property.Name[1..];
                writer.WritePropertyName(name);
                property.Value.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }
}

internal sealed record ReadOnlyHostStatusResult(bool Ok, string Json);

internal sealed record ReadOnlyHostStatusRequest(string Command, string? ApplicationGenerationId);
