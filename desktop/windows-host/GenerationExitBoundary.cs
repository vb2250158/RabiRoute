using System.Diagnostics;

namespace RabiRoute.WindowsHost;

internal static class GenerationExitBoundary
{
    internal static async Task WaitAsync(Func<bool> hasExited, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var elapsed = Stopwatch.StartNew();
        while (!hasExited())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (elapsed.Elapsed >= timeout)
                throw new TimeoutException("The original generation has not confirmed process and Job exit.");
            await Task.Delay(TimeSpan.FromMilliseconds(25), cancellationToken);
        }
    }
}

// Retain the original native handles and cleanup operation across an uncertain
// exit. A new generation is fenced until this exact operation confirms exit.
internal sealed class GenerationExitUnconfirmedException : Exception
{
    private readonly Func<Task> _retry;
    internal string GenerationId { get; }
    internal GenerationExitUnconfirmedException(string generationId, Func<Task> retry, Exception cause)
        : base($"Generation {generationId} exit is unconfirmed; replacement is fenced.", cause)
    { GenerationId = generationId; _retry = retry; }
    internal Task RetryAsync() => _retry();
}
