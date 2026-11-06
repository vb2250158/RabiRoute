import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getTimeoutMs } from "./timeoutSettings.js";

/** Shared local model-directory validation; feature callers retain their own public error identity. */
export function validateLocalModelDirectory(value: unknown, protectedRoots: string[], fixedDrive?: (drive: string) => boolean, error: (message: string) => Error = message => Object.assign(new Error(message), { status: 400 })): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024) throw error("模型目录必须是本机绝对路径。");
  const raw = value.trim();
  if (!raw) return null;
  if (!/^[a-zA-Z]:[\\/]/.test(raw) || /[\x00-\x1f<>"|?*]/.test(raw) || raw.slice(2).includes(":")) throw error("模型目录必须是本机磁盘绝对路径，不能使用网络、设备或相对路径。");
  if (raw.slice(3).split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))) throw error("模型目录包含不支持的路径段。");
  const normalized = path.win32.normalize(raw);
  if (normalized === path.win32.parse(normalized).root) throw error("不能将整个磁盘作为模型目录。");
  let existing = normalized;
  while (!fs.existsSync(existing)) {
    const parent = path.win32.dirname(existing);
    if (parent === existing) throw error("模型目录所在磁盘不可访问。");
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) throw error("模型目录不能指向文件。");
  const real = fs.realpathSync.native(existing);
  if (!/^[a-zA-Z]:[\\/]/.test(real)) throw error("模型目录不能通过链接指向网络或设备。");
  const resolved = path.win32.resolve(real, path.win32.relative(existing, normalized));
  const within = (candidate: string, root: string) => {
    const relative = path.win32.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
  };
  for (const root of protectedRoots) {
    let canonical = root;
    try { canonical = fs.realpathSync.native(root); } catch { /* lexical exclusion still applies */ }
    if (within(normalized, root) || within(resolved, canonical)) throw error("模型目录不能放在程序安装或源码目录内。");
  }
  for (let ancestor = real; ; ancestor = path.win32.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, ".git"))) throw error("模型目录不能放在源码工作树内。");
    if (path.win32.dirname(ancestor) === ancestor) break;
  }
  const isFixed = fixedDrive ?? ((drive: string) => {
    const script = "$d=Get-CimInstance Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $env:RABIROUTE_MODEL_DRIVE + [char]39); if($d.DriveType -eq 3){'fixed'}";
    try {
      return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: getTimeoutMs("backend.manager.speechModelSettings.validateModelRoot.execFileSync.timeout", 5000), maxBuffer: 4096, windowsHide: true,
        env: { ...process.env, RABIROUTE_MODEL_DRIVE: drive }, stdio: ["ignore", "pipe", "ignore"]
      }).trim() === "fixed";
    } catch { return false; }
  });
  if (![...new Set([real.slice(0, 2).toUpperCase(), normalized.slice(0, 2).toUpperCase()])].every(isFixed)) throw error("模型目录必须位于可验证的本机固定磁盘。");
  return normalized;
}
