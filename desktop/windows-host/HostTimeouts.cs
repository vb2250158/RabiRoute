using System.Text.Json;
using System.Diagnostics;

namespace RabiRoute.WindowsHost;

/// <summary>Read the global owner's timeout snapshot once when the Host starts.</summary>
internal static class HostTimeouts
{
    private static IReadOnlyDictionary<string, int> _overrides = new Dictionary<string, int>();

    internal static void Load(string stateRoot)
    {
        try { Configure(File.ReadAllText(Path.Combine(stateRoot, "data", "Config.json"))); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        { _overrides = new Dictionary<string, int>(); }
    }

    internal static void Configure(string json)
    {
        using var document = JsonDocument.Parse(json);
        var values = new Dictionary<string, int>(StringComparer.Ordinal);
        if (document.RootElement.ValueKind == JsonValueKind.Object &&
            document.RootElement.TryGetProperty("timeoutOverrides", out var settings) && settings.ValueKind == JsonValueKind.Object)
            foreach (var item in settings.EnumerateObject())
                if (item.Value.ValueKind == JsonValueKind.Number && item.Value.TryGetInt32(out var ms) && ms > 0)
                    values[item.Name] = ms;
        _overrides = values;
    }

    internal static TimeSpan Get(string key, TimeSpan fallback) =>
        _overrides.TryGetValue(key, out var ms) ? TimeSpan.FromMilliseconds(ms) : fallback;

    internal static string SnapshotJson() => JsonSerializer.Serialize(_overrides);

    internal static DeadlineLease Deadline(TimeSpan duration) => new(duration);

    // A startup command combines several independently configurable deadlines.
    // Rearm a bounded timer so their sum does not overflow the platform timer.
    internal sealed class DeadlineLease : IDisposable
    {
        private readonly object _gate = new();
        private readonly CancellationTokenSource _source = new();
        private readonly Stopwatch _elapsed = Stopwatch.StartNew();
        private readonly TimeSpan _duration;
        private readonly Timer _timer;
        private bool _disposed;
        internal CancellationToken Token => _source.Token;

        internal DeadlineLease(TimeSpan duration)
        {
            _duration = duration;
            _timer = new Timer(_ => Tick(), null, Timeout.Infinite, Timeout.Infinite);
            Arm();
        }

        private void Arm() => _timer.Change((int)Math.Clamp(Math.Ceiling((_duration - _elapsed.Elapsed).TotalMilliseconds), 1, int.MaxValue), Timeout.Infinite);
        private void Tick()
        {
            lock (_gate)
            {
                if (_disposed) return;
                if (_elapsed.Elapsed >= _duration) _source.Cancel();
                else Arm();
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                _timer.Dispose();
                _source.Dispose();
            }
        }
    }
}
