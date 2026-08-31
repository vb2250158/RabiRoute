using Microsoft.Win32.SafeHandles;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace RabiRoute.WindowsHost;

internal sealed record HostControlPeerSnapshot(
    uint? ClientPid,
    DateTimeOffset? ClientStartedAt,
    string? ClientSidHash,
    string? ClientImagePath,
    uint? ParentPid,
    DateTimeOffset? ParentStartedAt,
    string? ParentImagePath,
    uint? SessionId,
    IReadOnlyList<string> CaptureErrors);

internal sealed record HostOperationContext(
    string OperationId,
    DateTimeOffset AcceptedAt,
    HostControlPeerSnapshot Peer,
    string ActorKind);

internal sealed record HostAuditEvent(
    int SchemaVersion,
    DateTimeOffset Timestamp,
    string Phase,
    string OperationId,
    string ActorKind,
    string Operation,
    string Reason,
    string? RequestedGenerationId,
    string? ActiveGenerationId,
    string Result,
    string ResultState,
    long DurationMs,
    HostControlPeerSnapshot Peer);

internal static class HostControlPeerInspector
{
    private const uint ProcessQueryLimitedInformation = 0x1000;

    internal static HostControlPeerSnapshot CaptureConnection(NamedPipeServerStream pipe)
    {
        var errors = new List<string>();
        uint? clientPid = null;
        DateTimeOffset? clientStartedAt = null;
        string? clientImagePath = null;
        string? clientSidHash = null;
        uint? parentPid = null;
        DateTimeOffset? parentStartedAt = null;
        string? parentImagePath = null;
        uint? sessionId = null;

        if (NativePeerMethods.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var exactClientPid))
        {
            clientPid = exactClientPid;
            CaptureProcess(exactClientPid, true, out clientStartedAt, out clientImagePath, out clientSidHash, errors, "client");
            if (NativePeerMethods.ProcessIdToSessionId(exactClientPid, out var exactSessionId)) sessionId = exactSessionId;
            else errors.Add($"client_session:{Marshal.GetLastWin32Error()}");
            parentPid = ParentProcessId(exactClientPid, errors);
            if (parentPid is uint exactParentPid)
            {
                CaptureProcess(exactParentPid, false, out parentStartedAt, out parentImagePath, out _, errors, "parent");
            }
        }
        else
        {
            errors.Add($"client_pid:{Marshal.GetLastWin32Error()}");
        }

        return new HostControlPeerSnapshot(
            clientPid,
            clientStartedAt,
            clientSidHash,
            clientImagePath,
            parentPid,
            parentStartedAt,
            parentImagePath,
            sessionId,
            errors.AsReadOnly());
    }

    internal static string ActorKind(HostControlPeerSnapshot peer)
    {
        if (peer.ClientPid is null || peer.ClientStartedAt is null || peer.ClientSidHash is null || peer.ClientImagePath is null)
            return "unresolved";
        if (!string.Equals(peer.ClientSidHash, HostIdentity.CurrentUserKey(), StringComparison.Ordinal))
            return "unresolved";
        var hostImage = Environment.ProcessPath;
        return !string.IsNullOrWhiteSpace(hostImage)
            && string.Equals(Path.GetFullPath(peer.ClientImagePath), Path.GetFullPath(hostImage), StringComparison.OrdinalIgnoreCase)
            ? "host-cli"
            : "same-user-unknown";
    }

    private static void CaptureProcess(
        uint processId,
        bool captureSid,
        out DateTimeOffset? startedAt,
        out string? imagePath,
        out string? sidHash,
        List<string> errors,
        string label)
    {
        startedAt = null;
        imagePath = null;
        sidHash = null;
        using var process = NativePeerMethods.OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process.IsInvalid)
        {
            errors.Add($"{label}_open:{Marshal.GetLastWin32Error()}");
            return;
        }
        var image = new StringBuilder(32_768);
        var imageLength = image.Capacity;
        if (NativePeerMethods.QueryFullProcessImageNameW(process, 0, image, ref imageLength)) imagePath = image.ToString();
        else errors.Add($"{label}_image:{Marshal.GetLastWin32Error()}");
        if (NativePeerMethods.GetProcessTimes(process, out var created, out _, out _, out _))
            startedAt = DateTimeOffset.FromFileTime(created.ToLong());
        else errors.Add($"{label}_started:{Marshal.GetLastWin32Error()}");
        if (!captureSid) return;
        if (!NativePeerMethods.OpenProcessToken(process, NativePeerMethods.TokenQuery, out var token))
        {
            errors.Add($"{label}_token:{Marshal.GetLastWin32Error()}");
            return;
        }
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
        {
            var sid = identity.User?.Value;
            if (!string.IsNullOrWhiteSpace(sid)) sidHash = HostIdentity.UserKey(sid);
            else errors.Add($"{label}_sid:missing");
        }
    }

    private static uint? ParentProcessId(uint processId, List<string> errors)
    {
        using var snapshot = NativePeerMethods.CreateToolhelp32Snapshot(NativePeerMethods.Th32csSnapProcess, 0);
        if (snapshot.IsInvalid)
        {
            errors.Add($"parent_snapshot:{Marshal.GetLastWin32Error()}");
            return null;
        }
        var entry = new NativePeerMethods.ProcessEntry32 { Size = (uint)Marshal.SizeOf<NativePeerMethods.ProcessEntry32>() };
        if (!NativePeerMethods.Process32FirstW(snapshot, ref entry))
        {
            errors.Add($"parent_first:{Marshal.GetLastWin32Error()}");
            return null;
        }
        do
        {
            if (entry.ProcessId == processId) return entry.ParentProcessId;
            entry.Size = (uint)Marshal.SizeOf<NativePeerMethods.ProcessEntry32>();
        } while (NativePeerMethods.Process32NextW(snapshot, ref entry));
        errors.Add("parent_pid:not_found");
        return null;
    }

    private static class NativePeerMethods
    {
        internal const uint Th32csSnapProcess = 0x00000002;
        internal const uint TokenQuery = 0x0008;

        [StructLayout(LayoutKind.Sequential)]
        internal struct FileTime
        {
            internal uint Low;
            internal uint High;
            internal long ToLong() => unchecked((long)(((ulong)High << 32) | Low));
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct ProcessEntry32
        {
            internal uint Size;
            internal uint Usage;
            internal uint ProcessId;
            internal IntPtr DefaultHeapId;
            internal uint ModuleId;
            internal uint Threads;
            internal uint ParentProcessId;
            internal int PriorityBase;
            internal uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string ExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeProcessHandle OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenProcessToken(SafeProcessHandle process, uint desiredAccess, out SafeAccessTokenHandle token);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder imagePath, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetProcessTimes(SafeProcessHandle process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool Process32FirstW(SafeFileHandle snapshot, ref ProcessEntry32 entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool Process32NextW(SafeFileHandle snapshot, ref ProcessEntry32 entry);
    }
}

internal interface IHostLifecycleAudit
{
    bool Append(HostAuditEvent entry);
}

internal sealed class HostLifecycleAudit : IHostLifecycleAudit
{
    private readonly string _root;
    private readonly object _gate = new();
    private readonly Func<string, IEnumerable<string>> _readLines;
    private readonly HashSet<string> _terminalOperationIds = new(StringComparer.Ordinal);
    private string? _terminalIndexPath;

    internal HostLifecycleAudit(
        string? root = null,
        Func<string, IEnumerable<string>>? readLines = null)
    {
        _root = root ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RabiRoute",
            "diagnostics",
            "host");
        _readLines = readLines ?? File.ReadLines;
    }

    public bool Append(HostAuditEvent entry)
    {
        string payload;
        try
        {
            payload = JsonSerializer.Serialize(entry, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
        }
        catch { return false; }

        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                lock (_gate)
                {
                    Directory.CreateDirectory(_root);
                    var filePath = Path.Combine(_root, $"lifecycle-audit-{entry.Timestamp:yyyyMMdd}.jsonl");
                    if (entry.Phase == "completed")
                    {
                        EnsureTerminalIndex(filePath);
                        if (_terminalOperationIds.Contains(entry.OperationId)) return true;
                    }
                    try
                    {
                        using var stream = new FileStream(filePath, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
                        using var writer = new StreamWriter(stream, new UTF8Encoding(false), 4096, leaveOpen: true);
                        writer.WriteLine(payload);
                        writer.Flush();
                        stream.Flush(true);
                    }
                    catch
                    {
                        if (!ContainsExactRecord(filePath, payload)) throw;
                    }
                    if (entry.Phase == "completed") _terminalOperationIds.Add(entry.OperationId);
                    return true;
                }
            }
            catch when (attempt < 2)
            {
                InvalidateTerminalIndex(entry);
                Thread.Sleep(attempt == 0 ? 25 : 100);
            }
            catch
            {
                InvalidateTerminalIndex(entry);
                return false;
            }
        }
        return false;
    }

    private void EnsureTerminalIndex(string filePath)
    {
        if (string.Equals(_terminalIndexPath, filePath, StringComparison.OrdinalIgnoreCase)) return;
        var recovered = new HashSet<string>(StringComparer.Ordinal);
        if (File.Exists(filePath))
        {
            foreach (var line in _readLines(filePath))
            {
                var operationId = ReadTerminalOperationId(line);
                if (operationId is not null) recovered.Add(operationId);
            }
        }
        _terminalOperationIds.Clear();
        _terminalOperationIds.UnionWith(recovered);
        _terminalIndexPath = filePath;
    }

    private void InvalidateTerminalIndex(HostAuditEvent entry)
    {
        if (entry.Phase != "completed") return;
        lock (_gate)
        {
            _terminalIndexPath = null;
            _terminalOperationIds.Clear();
        }
    }

    private static bool ContainsExactRecord(string filePath, string payload)
    {
        if (!File.Exists(filePath)) return false;
        foreach (var line in File.ReadLines(filePath))
        {
            if (string.Equals(line, payload, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static string? ReadTerminalOperationId(string line)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            return root.TryGetProperty("phase", out var phase) && phase.GetString() == "completed" &&
                   root.TryGetProperty("operationId", out var id)
                ? id.GetString()
                : null;
        }
        catch (JsonException)
        {
            // A torn or foreign line is not an authoritative terminal receipt.
            return null;
        }
    }
}
