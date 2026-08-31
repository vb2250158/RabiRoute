using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace RabiRoute.WindowsHost;

internal sealed class WindowsJob : IDisposable
{
    private readonly SafeJobHandle _handle;

    internal WindowsJob(string generationId)
    {
        _handle = NativeMethods.CreateJobObjectW(IntPtr.Zero, $"RabiRoute.Generation.{generationId}");
        if (_handle.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed.");
        }

        var information = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var size = Marshal.SizeOf<NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, pointer, false);
            if (!NativeMethods.SetInformationJobObject(
                    _handle,
                    NativeMethods.JobObjectExtendedLimitInformation,
                    pointer,
                    (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    internal SafeJobHandle Handle => _handle;

    internal IReadOnlyList<uint> MemberProcessIds()
    {
        const int headerBytes = 8;
        var capacity = 8;
        while (true)
        {
            var length = checked(headerBytes + capacity * IntPtr.Size);
            var buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.WriteInt32(buffer, 0, 0);
                Marshal.WriteInt32(buffer, sizeof(uint), 0);
                if (NativeMethods.QueryInformationJobObject(
                        _handle,
                        NativeMethods.JobObjectBasicProcessIdList,
                        buffer,
                        (uint)length,
                        out _))
                {
                    var count = Marshal.ReadInt32(buffer, sizeof(uint));
                    var members = new uint[count];
                    for (var index = 0; index < count; index++)
                    {
                        members[index] = checked((uint)(long)Marshal.ReadIntPtr(buffer, headerBytes + index * IntPtr.Size));
                    }
                    Array.Sort(members);
                    return members;
                }

                var error = Marshal.GetLastWin32Error();
                if (error != NativeMethods.ERROR_MORE_DATA)
                {
                    throw new Win32Exception(error, "QueryInformationJobObject failed.");
                }
                var assigned = Marshal.ReadInt32(buffer, 0);
                capacity = Math.Max(capacity * 2, assigned);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    internal void Terminate(uint exitCode = 1)
    {
        if (!_handle.IsClosed && !NativeMethods.TerminateJobObject(_handle, exitCode))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != NativeMethods.ERROR_ACCESS_DENIED)
            {
                throw new Win32Exception(error, "TerminateJobObject failed.");
            }
        }
    }

    public void Dispose() => _handle.Dispose();
}

internal sealed class NativeChildProcess : IDisposable
{
    private readonly SafeProcessHandle _processHandle;
    private readonly StreamReader _standardOutput;
    private readonly StreamReader _standardError;

    private NativeChildProcess(
        SafeProcessHandle processHandle,
        uint processId,
        StreamReader standardOutput,
        StreamReader standardError)
    {
        _processHandle = processHandle;
        ProcessId = processId;
        _standardOutput = standardOutput;
        _standardError = standardError;
    }

    internal uint ProcessId { get; }
    internal StreamReader StandardOutput => _standardOutput;
    internal StreamReader StandardError => _standardError;
    internal bool HasExited
    {
        get
        {
            var result = NativeMethods.WaitForSingleObject(_processHandle, 0);
            if (result == NativeMethods.WAIT_OBJECT_0) return true;
            if (result == NativeMethods.WAIT_TIMEOUT) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
        }
    }

    internal static unsafe NativeChildProcess StartSuspendedInJob(
        WindowsJob job,
        string executable,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        IReadOnlyDictionary<string, string?> environmentOverrides)
    {
        SafeFileHandle? stdoutRead = null;
        SafeFileHandle? stdoutWrite = null;
        SafeFileHandle? stderrRead = null;
        SafeFileHandle? stderrWrite = null;
        SafeProcessHandle? processHandle = null;
        StreamReader? standardOutput = null;
        StreamReader? standardError = null;
        try
        {
            stdoutRead = CreateInheritablePipe(out stdoutWrite);
            stderrRead = CreateInheritablePipe(out stderrWrite);
            var startupInfo = new NativeMethods.STARTUPINFO
            {
                cb = (uint)Marshal.SizeOf<NativeMethods.STARTUPINFO>(),
                dwFlags = NativeMethods.STARTF_USESTDHANDLES,
                hStdInput = NativeMethods.GetStdHandle(NativeMethods.STD_INPUT_HANDLE),
                hStdOutput = stdoutWrite.DangerousGetHandle(),
                hStdError = stderrWrite.DangerousGetHandle()
            };
            var commandLine = new StringBuilder(BuildCommandLine(executable, arguments));
            var environment = BuildEnvironmentBlock(environmentOverrides);
            NativeMethods.PROCESS_INFORMATION processInformation;
            fixed (byte* environmentPointer = environment)
            {
                if (!NativeMethods.CreateProcessW(
                        executable,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        NativeMethods.CREATE_SUSPENDED |
                        NativeMethods.CREATE_NO_WINDOW |
                        NativeMethods.CREATE_UNICODE_ENVIRONMENT,
                        (IntPtr)environmentPointer,
                        workingDirectory,
                        ref startupInfo,
                        out processInformation))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), $"CreateProcessW failed for {executable}.");
                }
            }

            using var threadHandle = new SafeNativeHandle(processInformation.hThread, ownsHandle: true);
            processHandle = new SafeProcessHandle(processInformation.hProcess, ownsHandle: true);
            try
            {
                if (!NativeMethods.AssignProcessToJobObject(job.Handle, processHandle))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed.");
                }
                if (NativeMethods.ResumeThread(threadHandle) == uint.MaxValue)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed.");
                }
            }
            catch
            {
                NativeMethods.TerminateProcess(processHandle, 1);
                processHandle.Dispose();
                throw;
            }

            // CreatePipe returns synchronous handles. Marking them asynchronous makes
            // FileStream probe for overlapped I/O and can block during child startup.
            standardOutput = new StreamReader(
                new FileStream(stdoutRead, FileAccess.Read, 4096, isAsync: false),
                Encoding.UTF8,
                true,
                4096);
            stdoutRead = null;
            standardError = new StreamReader(
                new FileStream(stderrRead, FileAccess.Read, 4096, isAsync: false),
                Encoding.UTF8,
                true,
                4096);
            stderrRead = null;
            var child = new NativeChildProcess(
                processHandle,
                processInformation.dwProcessId,
                standardOutput,
                standardError);
            processHandle = null;
            standardOutput = null;
            standardError = null;
            return child;
        }
        finally
        {
            standardOutput?.Dispose();
            standardError?.Dispose();
            processHandle?.Dispose();
            stdoutRead?.Dispose();
            stdoutWrite?.Dispose();
            stderrRead?.Dispose();
            stderrWrite?.Dispose();
        }
    }

    internal Task<int> WaitForExitAsync(CancellationToken cancellationToken = default) => Task.Run(() =>
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var result = NativeMethods.WaitForSingleObject(_processHandle, 250);
            if (result == NativeMethods.WAIT_OBJECT_0)
            {
                if (!NativeMethods.GetExitCodeProcess(_processHandle, out var exitCode))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed.");
                }
                return unchecked((int)exitCode);
            }
            if (result == NativeMethods.WAIT_FAILED)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
            }
        }
    }, cancellationToken);

    internal bool TryCloseMainWindow()
    {
        using var process = System.Diagnostics.Process.GetProcessById((int)ProcessId);
        return process.CloseMainWindow();
    }

    public void Dispose()
    {
        _standardOutput.Dispose();
        _standardError.Dispose();
        _processHandle.Dispose();
    }

    internal static string BuildCommandLine(string executable, IReadOnlyList<string> arguments)
    {
        return string.Join(" ", new[] { executable }.Concat(arguments).Select(QuoteWindowsArgument));
    }

    internal static string QuoteWindowsArgument(string argument)
    {
        if (argument.Length > 0 && !argument.Any(character => char.IsWhiteSpace(character) || character == '"'))
        {
            return argument;
        }

        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2).Append('"');
        return result.ToString();
    }

    private static SafeFileHandle CreateInheritablePipe(out SafeFileHandle writeHandle)
    {
        var attributes = new NativeMethods.SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf<NativeMethods.SECURITY_ATTRIBUTES>(),
            bInheritHandle = true
        };
        if (!NativeMethods.CreatePipe(out var readHandle, out writeHandle, ref attributes, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed.");
        }
        if (!NativeMethods.SetHandleInformation(readHandle, NativeMethods.HANDLE_FLAG_INHERIT, 0))
        {
            readHandle.Dispose();
            writeHandle.Dispose();
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetHandleInformation failed.");
        }
        return readHandle;
    }

    private static byte[] BuildEnvironmentBlock(IReadOnlyDictionary<string, string?> overrides)
    {
        var values = Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value, StringComparer.OrdinalIgnoreCase);
        foreach (var pair in overrides)
        {
            if (pair.Value is null) values.Remove(pair.Key);
            else values[pair.Key] = pair.Value;
        }
        var text = string.Join('\0', values.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
            .Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
        return Encoding.Unicode.GetBytes(text);
    }
}

internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeJobHandle() : base(true) { }
    protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
}

internal sealed class SafeNativeHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    internal SafeNativeHandle(IntPtr handle, bool ownsHandle) : base(ownsHandle) => SetHandle(handle);
    protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
}

internal static class NativeMethods
{
    internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    internal const int JobObjectExtendedLimitInformation = 9;
    internal const int JobObjectBasicProcessIdList = 3;
    internal const uint CREATE_SUSPENDED = 0x00000004;
    internal const uint CREATE_NO_WINDOW = 0x08000000;
    internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    internal const uint STARTF_USESTDHANDLES = 0x00000100;
    internal const int STD_INPUT_HANDLE = -10;
    internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
    internal const uint WAIT_OBJECT_0 = 0;
    internal const uint WAIT_TIMEOUT = 0x00000102;
    internal const uint WAIT_FAILED = 0xFFFFFFFF;
    internal const int ERROR_ACCESS_DENIED = 5;
    internal const int ERROR_MORE_DATA = 234;

    [StructLayout(LayoutKind.Sequential)]
    internal struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct STARTUPINFO
    {
        internal uint cb;
        internal string? lpReserved;
        internal string? lpDesktop;
        internal string? lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal short wShowWindow;
        internal short cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern SafeJobHandle CreateJobObjectW(IntPtr jobAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetInformationJobObject(SafeJobHandle job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryInformationJobObject(
        SafeJobHandle job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(SafeJobHandle job, SafeProcessHandle process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SECURITY_ATTRIBUTES pipeAttributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(SafeNativeHandle thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);
}
