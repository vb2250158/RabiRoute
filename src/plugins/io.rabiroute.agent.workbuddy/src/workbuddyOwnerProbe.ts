import { execFile } from "node:child_process";
import type { WorkbuddySessionDescriptor } from "./workbuddySessionStore.js";

export type WorkbuddyOwnerConnection = { pid: number; sessionId: string; endpoint: string; password: string; processStartFileTime: string };
export type WorkbuddyOwnerProbeResult = { owners: WorkbuddyOwnerConnection[]; warnings: Array<{ pid: number; code: string }> };

// The bounded, read-only OS probe uses the existing Manager token. It neither
// changes privileges nor starts or modifies WorkBuddy. Credentials stay on the
// private child-process pipe and are never part of public scan results.
const PROBE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$requested = ConvertFrom-Json ([Console]::In.ReadToEnd())
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class WorkbuddyOwnerEnvironmentProbe {
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation {
        public IntPtr Reserved1, PebBaseAddress, Reserved2A, Reserved2B, ProcessId, ParentProcessId;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr count, out UIntPtr read);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int kind, ref ProcessBasicInformation info, int size, out int returned);
    private static long ReadPointer(IntPtr process, long address) {
        byte[] bytes = new byte[8]; UIntPtr read;
        if (!ReadProcessMemory(process, new IntPtr(address), bytes, (UIntPtr)8, out read) || read.ToUInt64() != 8)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return BitConverter.ToInt64(bytes, 0);
    }
    public static string ReadGatewayPassword(int processId) {
        if (IntPtr.Size != 8) throw new NotSupportedException("Probe requires a 64-bit host.");
        IntPtr process = OpenProcess(0x410, false, processId);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            bool wow64;
            if (!IsWow64Process(process, out wow64) || wow64) throw new NotSupportedException("Probe requires a 64-bit owner.");
            var info = new ProcessBasicInformation(); int returned;
            int status = NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(info), out returned);
            if (status != 0) throw new InvalidOperationException("Owner process information is unavailable.");
            long parameters = ReadPointer(process, info.PebBaseAddress.ToInt64() + 0x20);
            long environment = ReadPointer(process, parameters + 0x80);
            var contents = new StringBuilder();
            for (int offset = 0; offset < 1024 * 1024; offset += 1024) {
                byte[] bytes = new byte[1024]; UIntPtr read;
                ReadProcessMemory(process, new IntPtr(environment + offset), bytes, (UIntPtr)bytes.Length, out read);
                int count = (int)read.ToUInt64();
                if (count == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                contents.Append(Encoding.Unicode.GetString(bytes, 0, count - count % 2));
                string text = contents.ToString();
                int end = text.IndexOf("\0\0", StringComparison.Ordinal);
                if (end < 0) continue;
                const string prefix = "CODEBUDDY_GATEWAY_PASSWORD=";
                foreach (string entry in text.Substring(0, end).Split('\0'))
                    if (entry.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return entry.Substring(prefix.Length);
                return null;
            }
            throw new InvalidOperationException("Owner environment exceeds the bounded probe size.");
        } finally { CloseHandle(process); }
    }
}
'@

$owners = @()
$warnings = @()
$ids = @($requested | ForEach-Object { [int]$_.pid })
$listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $ids -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' })
foreach ($owner in $requested) {
    try {
        $process = Get-Process -Id ([int]$owner.pid) -ErrorAction Stop
        if ($process.ProcessName -ne 'WorkBuddy') { throw 'Unexpected owner executable.' }
        $started = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        # WorkBuddy records an estimated creation time. Current descriptors differ
        # from the OS timestamp by tens of milliseconds. Keep the check bounded
        # to the same second while also verifying executable, PID and gateway auth.
        if (-not $owner.processStartFileTime -or [Math]::Abs(([decimal]$started) - ([decimal]$owner.processStartFileTime)) -ge 10000000) { throw 'Owner process identity changed.' }
        $password = [WorkbuddyOwnerEnvironmentProbe]::ReadGatewayPassword([int]$owner.pid)
        if (-not $password) { throw 'Owner has no gateway credential.' }
        foreach ($listener in @($listeners | Where-Object { $_.OwningProcess -eq $owner.pid })) {
            $endpoint = 'http://127.0.0.1:' + $listener.LocalPort
            try {
                $health = Invoke-RestMethod ($endpoint + '/api/v1/health') -Headers @{Authorization=('Bearer ' + $password);'X-CodeBuddy-Request'='1'} -TimeoutSec 2
                if (-not $health.data) { continue }
                $owners += @{pid=[int]$owner.pid;sessionId=$owner.sessionId;endpoint=$endpoint;password=$password;processStartFileTime=$owner.processStartFileTime}
                break
            } catch { }
        }
    } catch { $warnings += @{pid=[int]$owner.pid;code='WORKBUDDY_OWNER_PROBE_UNAVAILABLE';reason=$_.Exception.Message} }
    finally { $password = $null }
}
@{owners=$owners;warnings=$warnings} | ConvertTo-Json -Depth 5 -Compress
`;

export function probeWorkbuddyOwners(descriptors: readonly WorkbuddySessionDescriptor[]): Promise<WorkbuddyOwnerProbeResult> {
  const owners = descriptors.filter(owner => owner.kind === "interactive" && owner.processAlive && owner.processStartFileTime);
  if (process.platform !== "win32" || owners.length === 0) return Promise.resolve({ owners: [], warnings: [] });
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE_SCRIPT], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8"
    }, (error, stdout) => {
      if (error) { reject(new Error("WorkBuddy 原生 owner 探测失败，请检查运行权限及进程状态。")); return; }
      try { resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/, "")) as WorkbuddyOwnerProbeResult); }
      catch { reject(new Error("WorkBuddy 原生 owner 探测返回了无效结果。")); }
    });
    child.stdin?.on("error", () => { /* execFile reports the original process failure. */ });
    child.stdin?.end(JSON.stringify(owners.map(({ pid, sessionId, processStartFileTime }) => ({ pid, sessionId, processStartFileTime }))));
  });
}
