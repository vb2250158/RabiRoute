using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using RabiRoute.WindowsBootstrap;

internal static class ReadOnlyHostStatusProbeTests
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        var absent = await ReadOnlyHostStatusProbe.QueryAsync(NewPipeName(), TimeSpan.FromMilliseconds(150));
        CheckUnknown(absent, "absent endpoint", check);
        check(!absent.IsRunning, "unknown first-start probe leaves the existing Core startup path available");

        var faulted = await ReplyAsync("{\"Ok\":true,\"State\":\"faulted\"}", TimeSpan.FromMilliseconds(100));
        check(faulted.ReceivedResponse && faulted.IsRunning && faulted.Json.Contains("\"faulted\""),
            "slow existing Host response retains the real faulted state");
        var stopped = await ReplyAsync("{\"Ok\":true,\"State\":\"stopped\"}", TimeSpan.Zero);
        check(stopped.Ok && stopped.ReceivedResponse && !stopped.IsRunning, "real Host stopped response remains distinguishable from unknown");

        CheckUnknown(await ReplyAsync("{invalid", TimeSpan.Zero), "damaged JSON", check);
        CheckUnknown(await ReplyAsync("[]", TimeSpan.Zero), "invalid response shape", check);
        CheckUnknown(await ReplyAsync("{}", TimeSpan.Zero), "missing response state", check);
        CheckUnknown(await ReplyAsync(null, TimeSpan.Zero), "connected response timeout", check);

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try
        {
            await ReadOnlyHostStatusProbe.QueryAsync(NewPipeName(), TimeSpan.FromSeconds(1), cancelled.Token);
            check(false, "caller cancellation propagates");
        }
        catch (OperationCanceledException) { check(true, "caller cancellation propagates"); }
    }

    private static void CheckUnknown(ReadOnlyHostStatusResult result, string scenario, Action<bool, string> check)
    {
        using var document = JsonDocument.Parse(result.Json);
        var root = document.RootElement;
        check(!result.Ok && !result.ReceivedResponse && !result.IsRunning &&
            root.GetProperty("ok").ValueKind == JsonValueKind.False && root.GetProperty("state").GetString() == "unknown",
            $"{scenario} reports unavailable status without claiming stopped");
    }

    private static async Task<ReadOnlyHostStatusResult> ReplyAsync(string? json, TimeSpan delay)
    {
        var name = NewPipeName();
        await using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var reply = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync(lifetime.Token);
            var header = new byte[4];
            await server.ReadExactlyAsync(header, lifetime.Token);
            var request = new byte[BinaryPrimitives.ReadInt32LittleEndian(header)];
            await server.ReadExactlyAsync(request, lifetime.Token);
            if (json is null)
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, lifetime.Token);
                return;
            }
            await Task.Delay(delay, lifetime.Token);
            var payload = Encoding.UTF8.GetBytes(json);
            BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
            await server.WriteAsync(header, lifetime.Token);
            await server.WriteAsync(payload, lifetime.Token);
            await server.FlushAsync(lifetime.Token);
        });
        try { return await ReadOnlyHostStatusProbe.QueryAsync(name, TimeSpan.FromMilliseconds(500)); }
        finally
        {
            lifetime.Cancel();
            try { await reply; }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        }
    }

    private static string NewPipeName() => $"RabiRoute.StatusProbe.Tests.{Guid.NewGuid():N}";
}
