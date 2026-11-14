using RabiRoute.WindowsHost;

internal static class GenerationExitTests
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        var oldManagerExited = false;
        var oldDescendantsExited = false;
        var replacementStarted = false;
        async Task ReplaceAsync()
        {
            await GenerationExitBoundary.WaitAsync(
                () => oldManagerExited && oldDescendantsExited,
                TimeSpan.FromSeconds(2), CancellationToken.None);
            replacementStarted = true;
        }
        var replacement = ReplaceAsync();
        await Task.Delay(60);
        check(!replacementStarted, "replacement waits after termination was requested but original Manager is still alive");
        oldManagerExited = true;
        await Task.Delay(60);
        check(!replacementStarted, "Manager exit alone cannot release the generation while an owned descendant remains");
        oldDescendantsExited = true;
        await replacement;
        check(replacementStarted, "replacement is admitted after both original roots and Job members confirm exit");

        var retainedHandles = true;
        var retryAllowed = false;
        async Task RetireAsync()
        {
            await GenerationExitBoundary.WaitAsync(() => retryAllowed, TimeSpan.FromMilliseconds(40), CancellationToken.None);
            retainedHandles = false;
        }
        GenerationExitUnconfirmedException? retained = null;
        try { await RetireAsync(); }
        catch (TimeoutException exception)
        { retained = new GenerationExitUnconfirmedException("original-generation", RetireAsync, exception); }
        check(retained is not null && retainedHandles, "exit timeout retains the original cleanup owner and native resources");
        retryAllowed = true;
        await retained!.RetryAsync();
        check(!retainedHandles, "retry releases the same owner's resources only after confirmed exit");

        var providerFailurePropagated = false;
        try
        {
            await GenerationExitBoundary.WaitAsync(() => throw new IOException("Job query failed"),
                TimeSpan.FromSeconds(1), CancellationToken.None);
        }
        catch (IOException) { providerFailurePropagated = true; }
        check(providerFailurePropagated, "Job query failure never becomes an empty generation");

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var cancellationObserved = false;
        try { await GenerationExitBoundary.WaitAsync(() => false, TimeSpan.FromSeconds(1), cancellation.Token); }
        catch (OperationCanceledException) { cancellationObserved = true; }
        check(cancellationObserved, "canceled exit wait does not release the replacement fence");
    }
}
