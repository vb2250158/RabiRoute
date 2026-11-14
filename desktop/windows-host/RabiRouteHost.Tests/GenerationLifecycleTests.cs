using System.Text.Json;
using System.Threading.Channels;
using RabiRoute.WindowsHost;

internal static class GenerationLifecycleTests
{
    private sealed class RecordingAudit : IHostLifecycleAudit
    {
        internal readonly List<HostAuditEvent> Events = new();
        public bool Append(HostAuditEvent entry) { Events.Add(entry); return true; }
    }

    private sealed class Generation(string id) : IApplicationGeneration
    {
        internal bool CanExit;
        internal int Disposals;
        internal int ConfirmedExits;
        public string Id => id;
        public ManagerReady Ready { get; } = new(1, id, "manager-" + id, 42, "http://127.0.0.1:43127", DateTimeOffset.UtcNow.ToString("O"));
        public Task<string> Failure { get; } = new TaskCompletionSource<string>().Task;
        public string HealthState => "healthy";
        public uint TrayPid => 43;
        public string TrayBoundManagerInstanceId => Ready.ManagerInstanceId;
        public IReadOnlyList<uint> JobMemberPids => CanExit ? Array.Empty<uint>() : new uint[] { 42, 43 };
        public Task<HostResponse> ForwardSourcePatchAsync(JsonElement payload, bool reconcile, CancellationToken cancellationToken, bool webPatch = false)
            => throw new NotSupportedException();
        public Task StopAndVerifyEmptyAsync(string reason, CancellationToken cancellationToken)
        {
            if (!CanExit) throw new TimeoutException("Controlled kernel exit is not yet signaled");
            ConfirmedExits++;
            return Task.CompletedTask;
        }
        public ValueTask DisposeAsync()
        {
            if (ConfirmedExits == 0) throw new InvalidOperationException("Original handles released before kernel exit");
            Disposals++;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly string DirectoryPath = Path.Combine(Path.GetTempPath(), "rabi-host-loop-" + Guid.NewGuid().ToString("N"));
        internal readonly Channel<QueuedCommand> Commands = Channel.CreateUnbounded<QueuedCommand>();
        internal readonly List<Generation> Started = new();
        internal readonly RecordingAudit Audit = new();
        internal readonly CancellationTokenSource Cancellation = new();
        internal readonly HostLog Log;
        internal readonly HostRuntime Runtime;
        internal Task<int>? Loop;
        internal Fixture()
        {
            Directory.CreateDirectory(DirectoryPath);
            Log = new HostLog(Path.Combine(DirectoryPath,"logs"));
            Runtime = new HostRuntime(DirectoryPath, DirectoryPath, Log, Audit, Commands, (id, _, _, _) => {
                var generation = new Generation(id) { CanExit = Started.Count != 0 };
                Started.Add(generation);
                return Task.FromResult<IApplicationGeneration>(generation);
            });
        }
        internal void Run() => Loop = Runtime.RunLifecycleLoopAsync(Cancellation.Token);
        internal async Task<HostResponse> Send(string name, string? fence = null, string? operationId = null)
        {
            var operation = new HostOperationContext(operationId ?? Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow,
                new HostControlPeerSnapshot(null,null,null,null,null,null,null,null,Array.Empty<string>()), "fixture-accepted-command");
            var sent = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            sent.SetResult(true);
            var completion = new TaskCompletionSource<HostResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
            await Commands.Writer.WriteAsync(new QueuedCommand(name,fence,operation,completion,sent));
            return await completion.Task.WaitAsync(TimeSpan.FromSeconds(3));
        }
        internal async Task<HostResponse> Ready()
        {
            for(var attempt=0;attempt<100;attempt++)
            {
                var status=await Send("status");
                if(status.ManagerInstanceId is not null) return status;
                await Task.Delay(10);
            }
            throw new TimeoutException("Controlled Host did not admit a generation");
        }
        public async ValueTask DisposeAsync()
        {
            foreach(var generation in Started) generation.CanExit=true;
            Cancellation.Cancel();
            if(Loop is not null) await Loop.WaitAsync(TimeSpan.FromSeconds(3));
            await Log.DisposeAsync();
            Cancellation.Dispose();
            Directory.Delete(DirectoryPath,true);
        }
    }

    internal static async Task RunAsync(Action<bool,string> check)
    {
        await using(var f=new Fixture())
        {
            f.Run();var ready=await f.Ready();var original=f.Started.Single();
            var restart=await f.Send("restart",ready.ControlFenceGenerationId,"restart-original");
            check(!restart.Ok && restart.State=="generation_exit_unconfirmed" && restart.OperationId=="restart-original",
                "active restart returns the original operation's unconfirmed-exit result instead of timing out");
            var status=await f.Send("status");
            check(status.State=="faulted" && status.ManagerBaseUrl is null && !f.Loop!.IsCompleted,
                "failed restart retains a live Host control loop and revokes the original endpoint");
            check(f.Started.Count==1 && original.Disposals==0,"failed restart cannot create a new generation or release original native handles");
            var quit=await f.Send("quit",ready.ControlFenceGenerationId,"quit-still-pending");
            check(!quit.Ok && quit.State=="generation_exit_unconfirmed" && quit.OperationId=="quit-still-pending" && !f.Loop!.IsCompleted,
                "faulted quit cannot acknowledge stopped while original kernel exit is unconfirmed");
            original.CanExit=true;
            var recovered=await f.Send("restart",ready.ControlFenceGenerationId,"restart-after-exit");
            check(recovered.Ok && f.Started.Count==2 && original.Disposals==1 && original.ConfirmedExits>0,
                "fenced recovery retires the original owner before admitting a replacement generation");
            var final=await f.Send("quit",recovered.ControlFenceGenerationId);
            check(final.Ok && final.State=="stopped" && await f.Loop! ==0,"confirmed replacement quit reaches the terminal stopped result");
            check(f.Audit.Events.Any(e=>e.OperationId=="restart-original" && e.Reason=="generation_exit_unconfirmed")
                && f.Audit.Events.Any(e=>e.OperationId=="quit-still-pending" && e.Reason=="generation_exit_unconfirmed"),
                "unconfirmed command audit preserves both original operation identities");
        }
        await using(var f=new Fixture())
        {
            f.Run();var ready=await f.Ready();var original=f.Started.Single();
            var quit=await f.Send("quit",ready.ControlFenceGenerationId,"active-quit-original");
            check(!quit.Ok && quit.State=="generation_exit_unconfirmed" && quit.OperationId=="active-quit-original",
                "active quit reports its own failed exit without losing its dequeued request");
            check(!f.Loop!.IsCompleted && f.Started.Count==1 && original.Disposals==0,"active quit failure retains Host, generation and original handles");
            original.CanExit=true;
            var final=await f.Send("quit",ready.ControlFenceGenerationId);
            check(final.Ok && final.State=="stopped" && await f.Loop==0 && original.Disposals==1,
                "faulted quit waits for the retained cleanup and confirms actual exit before stopped");
        }
        await using(var f=new Fixture())
        {
            f.Run();var ready=await f.Ready();var original=f.Started.Single();
            f.Cancellation.Cancel();
            var status=await f.Send("status");
            check(status.State=="faulted" && !f.Loop!.IsCompleted && original.Disposals==0,
                "canceled Host teardown retains the control loop when kernel exit is still unconfirmed");
            original.CanExit=true;
            var final=await f.Send("quit",ready.ControlFenceGenerationId);
            check(final.Ok && await f.Loop! ==0 && original.Disposals==1,
                "canceled Host teardown finishes only after original cleanup confirms exit");
        }
        await using(var f=new Fixture())
        {
            // An identity/reset fault may retain the generation before an exit exception exists.
            var original=new Generation("faulted-active-original");
            var flags=System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance;
            typeof(HostRuntime).GetField("_fenceGenerationId",flags)!.SetValue(f.Runtime,original.Id);
            typeof(HostRuntime).GetField("_generation",flags)!.SetValue(f.Runtime,original);
            typeof(HostRuntime).GetMethod("PublishState",flags)!.Invoke(f.Runtime,new object[]{"faulted"});
            var faultWait=(Task<string>)typeof(HostRuntime).GetMethod("WaitInFaultedStateAsync",flags)!
                .Invoke(f.Runtime,new object[]{CancellationToken.None})!;
            var rejected=await f.Send("quit",original.Id,"faulted-active-quit");
            check(!rejected.Ok && rejected.State=="generation_exit_unconfirmed" && !faultWait.IsCompleted && original.Disposals==0,
                "faulted quit also verifies a retained active generation when no prior exit exception was recorded");
            original.CanExit=true;
            var final=await f.Send("quit",original.Id);
            check(final.Ok && await faultWait=="quit" && original.Disposals==1,
                "faulted active generation cannot reach stopped until its native owner actually retires");
        }
        await using(var f=new Fixture())
        {
            // Reproduce the exact state at the prior iteration's finally boundary.
            var original=new Generation("iteration-original");
            typeof(HostRuntime).GetField("_fenceGenerationId",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Instance)!
                .SetValue(f.Runtime,original.Id);
            await f.Runtime.RetireIterationAsync(original);
            f.Run();
            var status=await f.Send("status");
            check(status.State=="faulted" && !f.Loop!.IsCompleted && f.Started.Count==0 && original.Disposals==0,
                "iteration-finally cleanup failure stays in retained faulted control state rather than escaping Run");
            var rejected=await f.Send("quit",original.Id,"iteration-quit-pending");
            check(!rejected.Ok && rejected.State=="generation_exit_unconfirmed" && f.Started.Count==0,
                "finally-retained owner fences both a replacement and an unconfirmed quit");
            original.CanExit=true;
            var final=await f.Send("quit",original.Id);
            check(final.Ok && await f.Loop! == 0 && original.Disposals==1,"finally-retained owner is released by its original cleanup after kernel confirmation");
        }
    }
}
