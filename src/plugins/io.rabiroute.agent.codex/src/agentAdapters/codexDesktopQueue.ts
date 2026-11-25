import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ownerProbe = String.raw`
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Owned($row) {
  if (!$row -or $row.SessionId -ne $self.SessionId) { return $false }
  $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
  return $owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid
}
$owners = @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | Where-Object {
  $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and (Owned $_)
})
if ($self.SessionId -eq 0 -or $owners.Count -ne 1) { exit 1 }
$owner = $owners[0]
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($owner.ParentProcessId)"
if (!(Owned $parent) -or $parent.Name -notin 'ChatGPT.exe','Codex.exe' -or $parent.CreationDate -gt $owner.CreationDate) { exit 1 }
$resources = Join-Path (Split-Path -Parent $parent.ExecutablePath) 'resources'
if (!$owner.ExecutablePath -or !(($owner.ExecutablePath).StartsWith($resources + '\', [StringComparison]::OrdinalIgnoreCase))) { exit 1 }
[pscustomobject]@{exe=$owner.ExecutablePath; pid=$owner.ProcessId; started=$owner.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress
`;

type DesktopOwner = { exe: string; pid: number; started: string };
type QueueCommand = (exe: string, args: string[], options: { timeout: number; windowsHide: boolean; cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
async function discoverOwner(): Promise<DesktopOwner> {
  const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execute(shell, ["-NoProfile", "-NonInteractive", "-Command", ownerProbe], { timeout: 8_000, windowsHide: true });
  const owner: DesktopOwner = JSON.parse(stdout);
  if (!path.isAbsolute(owner.exe) || !owner.pid || !owner.started) throw new Error("Cannot verify the running Codex Desktop owner.");
  return owner;
}

export async function prepareCodexDesktopQueue(input: { threadId: string; cwd: string; rolloutPath: string; prompt: string },
  dependencies: { platform: string; findOwner: () => Promise<DesktopOwner>; run: QueueCommand } =
    { platform: process.platform, findOwner: discoverOwner, run: execute }) {
  if (dependencies.platform !== "win32") throw new Error("Codex Desktop queue discovery requires Windows.");
  const home = path.join(os.homedir(), ".codex");
  const relative = path.relative(path.join(home, "sessions"), input.rolloutPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
    || [process.env.CODEX_HOME, process.env.CODEX_SQLITE_HOME].some(directory => directory && path.relative(home, directory))) {
    throw new Error("Codex Desktop queue requires the original task in the current Windows user's default Codex home.");
  }
  const runOptions = { timeout: 8_000, windowsHide: true, cwd: input.cwd, env: { ...process.env, CODEX_HOME: home } };
  const owner = await dependencies.findOwner();
  // Each Windows argument can grow by at most a factor of two when quoted.
  const args = ["queue", "--thread", input.threadId, "--message=" + input.prompt];
  if (input.prompt.includes("\0") || 2 * [owner.exe, ...args].reduce((length, value) => length + value.length + 3, 0) >= 32_767) {
    throw new Error("Codex Desktop queue message does not fit the Windows command line.");
  }
  const { stdout } = await dependencies.run(owner.exe, ["queue", "--help"], runOptions);
  if (!/^Usage:\s+codex(?:\.exe)?\s+queue(?:\s|$)/mi.test(stdout) || !stdout.includes("--thread") || !stdout.includes("--message")) {
    throw new Error("The running Codex Desktop CLI does not advertise thread queue support.");
  }
  return async (authorize: () => void | Promise<void>) => {
    const current = await dependencies.findOwner();
    if (current.pid !== owner.pid || current.started !== owner.started || current.exe !== owner.exe) {
      throw new Error("Codex Desktop owner changed before enqueue.");
    }
    await authorize();
    // CLI stdout acknowledges a queue write only. The caller verifies rollout evidence.
    await dependencies.run(owner.exe, args, runOptions);
  };
}
