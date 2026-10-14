import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
if (process.platform === "win32") {
  const root = fs.realpathSync.native(process.cwd());
  execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root,"scripts/build-agent-native-assets.ps1"), "-AgentRoot", path.join(root,"apps/rabi-agent")],
    {windowsHide:true,stdio:"inherit"});
} else {
  process.stdout.write("Windows native assets are compiled by Windows builds; clients can compile the same signed source when absent.\n");
}
