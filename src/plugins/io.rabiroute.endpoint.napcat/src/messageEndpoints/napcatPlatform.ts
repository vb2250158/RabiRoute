import path from "node:path";

/**
 * Platform helpers for NapCat on non-Windows hosts.
 *
 * Windows keeps its existing OneKey/Shell handling in napcatManager.ts. On Linux
 * RabiRoute supports two modes:
 *  - external: NapCat already runs elsewhere (Docker, another host, systemd);
 *    RabiRoute only needs the OneBot HTTP/WS URLs and token, no launch command.
 *  - local-shell: Linux QQ with NapCat.Shell installed by the official script
 *    (QQ binary at <root>/opt/QQ/qq or /opt/QQ/qq), started headless via xvfb-run.
 * Everything here is pure (filesystem access is injected) so it can be tested
 * on any platform.
 */

export type NapcatHostMode = "external" | "local-shell";

export type FileExists = (file: string) => boolean;

/** Relative location of NapCat inside a Linux QQ installation (official installer layout). */
export const LINUX_NAPCAT_APP_DIR = path.posix.join("resources", "app", "app_launcher", "napcat");

/** An instance without a launch command is an externally managed NapCat (e.g. Docker). */
export function napcatHostMode(instance: { launchCommand?: string }): NapcatHostMode {
  return instance.launchCommand?.trim() ? "local-shell" : "external";
}

/** Candidate Linux QQ install roots (directories that contain the `qq` binary). */
export function linuxQqInstallCandidates(homeDir: string, rootDir: string): string[] {
  const roots = [
    path.posix.join(homeDir, "Napcat", "opt", "QQ"),
    path.posix.join(homeDir, "NapCat", "opt", "QQ"),
    path.posix.resolve(rootDir, "..", "NapCat", "opt", "QQ"),
    path.posix.resolve(rootDir, "tools", "NapCat", "opt", "QQ"),
    "/opt/QQ"
  ];
  return [...new Set(roots)];
}

/** A QQ root qualifies as NapCat.Shell when both the QQ binary and the NapCat entry exist. */
export function isLinuxNapcatQqRoot(qqRoot: string, exists: FileExists): boolean {
  return exists(path.posix.join(qqRoot, "qq"))
    && exists(path.posix.join(qqRoot, LINUX_NAPCAT_APP_DIR, "napcat.mjs"));
}

export function detectLinuxNapcatQqRoots(homeDir: string, rootDir: string, exists: FileExists): string[] {
  return linuxQqInstallCandidates(homeDir, rootDir).filter(root => isLinuxNapcatQqRoot(root, exists));
}

export function linuxNapcatConfigDir(qqRoot: string): string {
  return path.posix.join(qqRoot, LINUX_NAPCAT_APP_DIR, "config");
}

export type LinuxLaunchInput = {
  commandPath: string;
  args: string[];
  botUserId?: string;
  /** Absolute path of xvfb-run when available; omit when a display exists or for no wrapping. */
  xvfbRun?: string;
  /** Whether a graphical display is available (DISPLAY / WAYLAND_DISPLAY set). */
  hasDisplay?: boolean;
};

export type LinuxLaunchResult = { commandPath: string; args: string[]; warnings: string[] };

/**
 * Adapt a Linux QQ launch: add `--no-sandbox` and `-q <uin>` for the QQ binary,
 * and wrap with `xvfb-run -a` when headless. Other commands (custom scripts,
 * `docker compose up`, etc.) pass through untouched.
 */
export function adaptLinuxNapcatLaunch(input: LinuxLaunchInput): LinuxLaunchResult {
  const warnings: string[] = [];
  const base = path.posix.basename(input.commandPath).toLowerCase();
  if (base !== "qq" && base !== "linuxqq") {
    return { commandPath: input.commandPath, args: [...input.args], warnings };
  }
  let args = [...input.args];
  if (!args.includes("--no-sandbox")) args = ["--no-sandbox", ...args];
  const uin = String(input.botUserId || "").trim();
  if (uin && !args.some(arg => arg === "-q" || arg === "--qq")) args = [...args, "-q", uin];
  if (input.hasDisplay) return { commandPath: input.commandPath, args, warnings };
  if (input.xvfbRun) return { commandPath: input.xvfbRun, args: ["-a", input.commandPath, ...args], warnings };
  warnings.push("未检测到图形显示（DISPLAY/WAYLAND_DISPLAY），也未找到 xvfb-run；Linux QQ 可能无法无头启动。建议安装 xvfb 或改用 NapCat Docker。");
  return { commandPath: input.commandPath, args, warnings };
}

export type LinuxProcessEntry = { pid: number; cmdline: string; exe?: string };

/** Pick NapCat/QQ processes from a /proc-style listing. */
export function filterLinuxNapcatProcesses(entries: LinuxProcessEntry[]): Array<{ name: string; pid: string }> {
  const result: Array<{ name: string; pid: string }> = [];
  for (const entry of entries) {
    const exeBase = path.posix.basename(entry.exe || entry.cmdline.split(/\s+/)[0] || "");
    const isQq = /^(qq|linuxqq)$/i.test(exeBase);
    const mentionsNapcat = /napcat/i.test(entry.cmdline) || /napcat/i.test(entry.exe || "");
    if (isQq || mentionsNapcat) result.push({ name: exeBase || "napcat", pid: String(entry.pid) });
  }
  return result;
}

export type ExternalEndpointCheck = { ok: boolean; errors: string[]; warnings: string[] };

/**
 * Validate the configuration needed for an externally running NapCat
 * (Docker or remote): an HTTP URL, and a token when the endpoint is not loopback.
 */
export function validateExternalNapcatEndpoint(instance: { httpUrl?: string; wsUrl?: string; accessToken?: string }): ExternalEndpointCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const check = (label: string, value: string | undefined, protocols: string[]): URL | null => {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (!protocols.includes(url.protocol)) errors.push(`${label} 协议应为 ${protocols.join(" / ")}：${value}`);
      return url;
    } catch {
      errors.push(`${label} 不是合法 URL：${value}`);
      return null;
    }
  };
  const http = check("httpUrl", instance.httpUrl, ["http:", "https:"]);
  const ws = check("wsUrl", instance.wsUrl, ["ws:", "wss:"]);
  if (!instance.httpUrl?.trim()) errors.push("外部 NapCat 需要配置 httpUrl（OneBot HTTP Server 地址）。");
  const loopback = (url: URL | null) => !url || ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (!instance.accessToken?.trim() && (!loopback(http) || !loopback(ws))) {
    warnings.push("非本机地址的 NapCat 未配置 accessToken，建议在 NapCat 网络配置中设置 token 并在此填写。");
  }
  return { ok: errors.length === 0, errors, warnings };
}
