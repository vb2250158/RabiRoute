using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace RabiRoute.WindowsBootstrap;

internal enum ElevatedTaskState { Missing, Ready, Foreign }
internal enum ElevationResult { Continue, HandedOff, Degraded }

internal interface IHostElevationDriver
{
    bool IsElevated { get; }
    ElevatedTaskState InspectTask();
    void RegisterTask();
    void StartTask();
    bool RequestRegistration();
}

internal static class HostElevation
{
    internal static ElevationResult Decide(IHostElevationDriver driver, bool taskInvocation = false)
    {
        try
        {
            if (taskInvocation && !driver.IsElevated) return ElevationResult.Degraded;
            var task = driver.InspectTask();
            if (task == ElevatedTaskState.Foreign) return ElevationResult.Degraded;
            if (driver.IsElevated)
            {
                if (task == ElevatedTaskState.Missing) driver.RegisterTask();
                return ElevationResult.Continue;
            }
            if (task == ElevatedTaskState.Ready)
            {
                driver.StartTask();
                return ElevationResult.HandedOff;
            }
            return driver.RequestRegistration() ? ElevationResult.HandedOff : ElevationResult.Degraded;
        }
        catch (Exception error) when (error is COMException or Win32Exception or UnauthorizedAccessException or IOException or InvalidOperationException or ArgumentException or System.Text.Json.JsonException)
        {
            return ElevationResult.Degraded;
        }
    }
}

internal sealed class WindowsHostElevationDriver : IHostElevationDriver, IDisposable
{
    private readonly string executable;
    private readonly string root;
    private readonly string sid;
    private readonly dynamic service;
    private readonly dynamic folder;
    private readonly string taskName;
    private string Owner => $"RabiRoute elevated Host; {sid}; {root}";

    internal WindowsHostElevationDriver(string executable)
    {
        this.executable = Path.GetFullPath(executable);
        root = Path.GetDirectoryName(this.executable)!;
        sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Windows user SID is unavailable.");
        taskName = TaskName(root, sid);
        service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")!)!;
        service.Connect();
        folder = service.GetFolder("\\");
    }

    internal static string TaskName(string root, string sid) => "RabiRoute.Host.Elevated." +
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid + "\n" + Path.GetFullPath(root).TrimEnd('\\').ToUpperInvariant())))[..16];

    public bool IsElevated => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    public ElevatedTaskState InspectTask()
    {
        dynamic task;
        try { task = folder.GetTask(taskName); }
        catch (FileNotFoundException) { return ElevatedTaskState.Missing; }
        catch (COMException error) when ((uint)error.HResult == 0x80070002) { return ElevatedTaskState.Missing; }
        try
        {
            dynamic definition = task.Definition;
            if (!task.Enabled || definition.RegistrationInfo.Description != Owner || definition.Actions.Count != 1 ||
                definition.Principal.RunLevel != 1 || definition.Principal.LogonType != 3 ||
                definition.Triggers.Count != 1 || definition.Triggers.Item(1).Type != 9 ||
                UserSid((string)definition.Triggers.Item(1).UserId) != sid || definition.Settings.MultipleInstances != 2) return ElevatedTaskState.Foreign;
            var principal = (string)definition.Principal.UserId;
            var principalSid = UserSid(principal);
            dynamic action = definition.Actions.Item(1);
            return principalSid == sid && action.Type == 0 &&
                string.Equals(Path.GetFullPath((string)action.Path), executable, StringComparison.OrdinalIgnoreCase) &&
                (string)action.Arguments == "--elevated-task" &&
                string.Equals(Path.GetFullPath((string)action.WorkingDirectory), root, StringComparison.OrdinalIgnoreCase)
                ? ElevatedTaskState.Ready : ElevatedTaskState.Foreign;
        }
        finally { Marshal.FinalReleaseComObject(task); }
    }

    private static string UserSid(string value)
    {
        try { return value.StartsWith("S-1-", StringComparison.Ordinal) ? value : ((SecurityIdentifier)new NTAccount(value).Translate(typeof(SecurityIdentifier))).Value; }
        catch (IdentityNotMappedException) { return ""; }
    }

    public void RegisterTask()
    {
        if (!IsElevated) throw new UnauthorizedAccessException("Host task registration requires foreground administrator approval.");
        if (InspectTask() != ElevatedTaskState.Missing) throw new InvalidOperationException("Existing Host task was not overwritten.");
        dynamic definition = service.NewTask(0);
        try
        {
            definition.RegistrationInfo.Description = Owner;
            definition.Principal.UserId = sid;
            definition.Principal.LogonType = 3;
            definition.Principal.RunLevel = 1;
            definition.Settings.Enabled = true;
            definition.Settings.Hidden = true;
            definition.Settings.AllowDemandStart = true;
            definition.Settings.MultipleInstances = 2;
            definition.Settings.ExecutionTimeLimit = "PT0S";
            definition.Settings.DisallowStartIfOnBatteries = false;
            definition.Settings.StopIfGoingOnBatteries = false;
            dynamic trigger = definition.Triggers.Create(9);
            trigger.UserId = sid;
            trigger.Enabled = ReadAutostart();
            dynamic action = definition.Actions.Create(0);
            action.Path = executable;
            action.Arguments = "--elevated-task";
            action.WorkingDirectory = root;
            dynamic registered = folder.RegisterTaskDefinition(taskName, definition, 2, sid, null, 3, null);
            Marshal.FinalReleaseComObject(registered);
        }
        finally { Marshal.FinalReleaseComObject(definition); }
        if (InspectTask() != ElevatedTaskState.Ready) throw new InvalidOperationException("Elevated Host task verification failed.");
    }

    private bool ReadAutostart()
    {
        var file = Path.Combine(root, "data", "desktop", "settings.json");
        if (!File.Exists(file)) return true;
        using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(file));
        return !document.RootElement.TryGetProperty("autostart", out var enabled) || enabled.ValueKind != System.Text.Json.JsonValueKind.False;
    }

    public void StartTask()
    {
        if (InspectTask() != ElevatedTaskState.Ready) throw new InvalidOperationException("No verified elevated Host task.");
        dynamic task = folder.GetTask(taskName);
        try { dynamic running = task.Run(null); Marshal.FinalReleaseComObject(running); }
        finally { Marshal.FinalReleaseComObject(task); }
    }

    internal void SetAutostart(bool enabled)
    {
        var state = InspectTask();
        if (state == ElevatedTaskState.Missing) return;
        if (!IsElevated || state != ElevatedTaskState.Ready) throw new UnauthorizedAccessException("Cannot update an unverified or non-owned Host task.");
        dynamic task = folder.GetTask(taskName);
        try
        {
            dynamic definition = task.Definition;
            if (definition.Triggers.Count != 1 || definition.Triggers.Item(1).Type != 9)
                throw new InvalidOperationException("Unexpected Host task trigger.");
            definition.Triggers.Item(1).Enabled = enabled;
            dynamic registered = folder.RegisterTaskDefinition(taskName, definition, 6, sid, null, 3, null);
            Marshal.FinalReleaseComObject(registered);
        }
        finally { Marshal.FinalReleaseComObject(task); }
    }

    public bool RequestRegistration()
    {
        try
        {
            var start = new ProcessStartInfo(executable) { UseShellExecute = true, Verb = "runas", WorkingDirectory = root };
            start.ArgumentList.Add("--register-elevated-host");
            start.ArgumentList.Add(sid);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Elevated registration did not start.");
            return process.WaitForExit(120000) && process.ExitCode == 0;
        }
        catch (Win32Exception error) when (error.NativeErrorCode == 1223) { return false; }
    }

    internal bool RegisterForCurrentOwner(string expectedSid)
    {
        if (!IsElevated || expectedSid != sid) return false;
        if (InspectTask() == ElevatedTaskState.Missing) RegisterTask();
        StartTask();
        return true;
    }

    public void Dispose()
    {
        Marshal.FinalReleaseComObject(folder);
        Marshal.FinalReleaseComObject(service);
    }
}
