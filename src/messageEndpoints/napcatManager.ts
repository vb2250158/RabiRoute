import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
  botUserId?: string | number;
};

type GatewayDefinition = {
  id: string;
  messageAdapterType?: string;
  messageAdapters?: string[];
  messageAdaptersDisabled?: string[];
  messageInputsDisabled?: boolean;
  messageAdapterPolicies?: Record<string, { inputEnabled?: boolean }>;
  gatewayPort: number;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatWebuiToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
};

type GatewayRuntime = {
  definition: GatewayDefinition;
  process?: unknown;
  status?: Record<string, unknown>;
};

type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

type MessageAdapterScanResult = {
  type: "napcat";
  label: string;
  maturity: "verified";
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: Array<{
    id: string;
    label: string;
    required?: boolean;
    ok?: boolean;
    detail?: string;
    actionLabel?: string;
    url?: string;
    path?: string;
  }>;
  warnings?: string[];
};

type NapcatManagerContext = {
  rootDir: string;
  getRuntimes(): Iterable<GatewayRuntime>;
  normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[];
  appendLog(runtime: GatewayRuntime, line: string): void;
  checkHttpEndpoint(url: string, timeoutMs?: number): Promise<boolean>;
};

type NapcatHealthRequest = {
  gatewayId?: string;
  instanceId?: string;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  gatewayPort?: number;
};

type NapcatConfigureRequest = NapcatHealthRequest;

type NapcatWebuiTokenInfo = {
  found: boolean;
  token?: string;
  tokenLength?: number;
  configPath?: string;
  configPort?: number;
  correctedWebuiUrl?: string;
  loginUrl?: string;
  message?: string;
  source?: "provided" | "config";
};

type NapcatLaunchRequest = {
  gatewayId?: string;
  instanceId?: string;
};

type NapcatLaunchPlan = {
  command: string;
  cwd: string;
  commandPath: string;
  args: string[];
  commandLine: string;
  redirectedFromOuterShell: boolean;
  botUserId?: string;
  warnings: string[];
};

type NapcatStopRequest = {
  gatewayId?: string;
  instanceId?: string;
  name?: string;
  gatewayPort?: number;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
};

type ManagedNapcatPrepareRequest = {
  id: string;
  name: string;
  index: number;
  gatewayPort: number;
  httpPort: number;
  webuiPort: number;
};

type ManagedNapcatPrepareResult = {
  instance: NapCatInstanceDefinition;
  steps: string[];
  loginUrl: string;
};

type NapcatOneBotResponse<T> = {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: T;
};

type NapcatWebuiResponse<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type NapcatWebuiSession = {
  baseUrl: string;
  credential: string;
};

type NapcatLoginInfo = {
  userId?: string | number;
  nickname?: string;
  online?: boolean;
  source?: "onebot-http" | "webui";
};

type NapcatOneBotNetworkConfig = {
  network?: {
    httpServers?: Array<Record<string, unknown>>;
    httpSseServers?: Array<Record<string, unknown>>;
    httpClients?: Array<Record<string, unknown>>;
    websocketServers?: Array<Record<string, unknown>>;
    websocketClients?: Array<Record<string, unknown>>;
    plugins?: Array<Record<string, unknown>>;
  };
};

type NormalizedNapcatOneBotNetworkConfig = {
  network: {
    httpServers: Array<Record<string, unknown>>;
    httpSseServers: Array<Record<string, unknown>>;
    httpClients: Array<Record<string, unknown>>;
    websocketServers: Array<Record<string, unknown>>;
    websocketClients: Array<Record<string, unknown>>;
    plugins: Array<Record<string, unknown>>;
  };
};

async function detectNapcatProcesses(): Promise<Array<{ name: string; pid: string }>> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], { timeout: 2500 });
    return String(stdout).split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.match(/^"([^"]+)","([^"]+)"/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ name: match[1], pid: match[2] }))
      .filter(item => /napcat|qqnt|^qq\.exe$/i.test(item.name));
  } catch {
    return [];
  }
}

function portFromUrl(value: string | undefined): number {
  try {
    return Number(new URL(value || "").port || 0);
  } catch {
    return 0;
  }
}

function localUrl(port: number, pathname = ""): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

function localWebuiUrlWithPort(webuiUrl: string, port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return "";
  try {
    const parsed = new URL(webuiUrl || localUrl(port, "/webui"));
    const host = parsed.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return "";
    parsed.port = String(port);
    if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/webui";
    return parsed.toString();
  } catch {
    return localUrl(port, "/webui");
  }
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function commandLineQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function resolveCommandPath(commandPath: string, cwd: string): string {
  if (path.isAbsolute(commandPath)) return path.resolve(commandPath);
  if (commandPath.includes("\\") || commandPath.includes("/")) return path.resolve(cwd, commandPath);
  return path.resolve(cwd, commandPath);
}

function findInnerNapcatLauncher(shellDir: string): string | null {
  const direct = path.join(shellDir, "launcher-user.bat");
  if (fs.existsSync(direct)) return direct;

  const versionsDir = path.join(shellDir, "versions");
  try {
    if (!fs.existsSync(versionsDir)) return null;
    const candidates: Array<{ file: string; mtimeMs: number }> = [];
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(versionsDir, entry.name, "resources", "app", "napcat", "launcher-user.bat");
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      candidates.push({ file, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
    return candidates[0]?.file ?? null;
  } catch {
    return null;
  }
}

function commandHasQuickLoginArg(args: string[]): boolean {
  return args.some((arg) => arg === "-q" || arg === "--quick-login" || arg === "--uin");
}

export function resolveNapcatLaunchPlan(instance: NapCatInstanceDefinition, rootDir: string): NapcatLaunchPlan {
  const command = instance.launchCommand?.trim();
  if (!command) {
    throw new Error("这个 NapCat 实例还没有填写启动命令。");
  }
  const cwd = path.resolve(instance.workingDir?.trim() || rootDir);
  const parts = splitCommandLine(command);
  const commandPath = resolveCommandPath(parts[0] || command, cwd);
  const args = parts.slice(1);
  const innerLauncher = findInnerNapcatLauncher(cwd);
  const commandBase = path.basename(commandPath).toLowerCase();
  const outerShellDetected = Boolean(innerLauncher)
    && (commandBase === "napcat.bat"
      || commandBase === "napcatwinbootmain.exe");
  const warnings: string[] = [];
  const botUserId = String(instance.botUserId || "").trim();
  let resolvedPath = commandPath;
  let resolvedArgs = [...args];
  if (outerShellDetected && innerLauncher) {
    resolvedPath = innerLauncher;
    if (botUserId && !commandHasQuickLoginArg(resolvedArgs)) {
      resolvedArgs = [...resolvedArgs, "-q", botUserId];
    } else if (!botUserId) {
      warnings.push("已识别外层 NapCat Shell 并切到内层 launcher-user.bat，但实例缺少 botUserId，无法自动追加 -q。");
    }
  }
  const commandLine = [resolvedPath, ...resolvedArgs].map(commandLineQuote).join(" ");
  return {
    command,
    cwd,
    commandPath: resolvedPath,
    args: resolvedArgs,
    commandLine,
    redirectedFromOuterShell: outerShellDetected,
    botUserId: botUserId || undefined,
    warnings
  };
}

function launchHiddenOnWindows(plan: NapcatLaunchPlan): void {
  const script = `Start-Process -FilePath 'cmd.exe' -ArgumentList ${psQuote(`/d /c ${plan.commandLine}`)} -WorkingDirectory ${psQuote(plan.cwd)} -WindowStyle Hidden`;
  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function newToken(): string {
  return randomBytes(8).toString("hex");
}

function candidateNapcatShellDirs(rootDir: string): string[] {
  const bases = [
    path.resolve(rootDir, "..", "NapCat"),
    path.resolve(rootDir, "..", "tools", "NapCat"),
    path.resolve(rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat"),
    path.resolve(os.homedir(), "AppData", "Local", "NapCat")
  ];
  const candidates: string[] = [];
  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        if (fs.existsSync(path.join(dir, "napcat.bat")) || fs.existsSync(path.join(dir, "NapCatWinBootMain.exe"))) {
          candidates.push(dir);
        }
      }
      if (fs.existsSync(path.join(base, "napcat.bat")) || fs.existsSync(path.join(base, "NapCatWinBootMain.exe"))) {
        candidates.push(base);
      }
    } catch {
      // Ignore inaccessible template roots.
    }
  }
  return [...new Set(candidates)];
}

function candidateNapcatShellZips(rootDir: string): string[] {
  const bases = [
    path.resolve(rootDir, "..", "NapCat"),
    path.resolve(rootDir, "..", "tools", "NapCat"),
    path.resolve(rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat")
  ];
  const zips: string[] = [];
  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isFile() && /NapCat.*Shell.*\.zip$/i.test(entry.name)) {
          zips.push(path.join(base, entry.name));
        }
      }
    } catch {
      // Ignore inaccessible template roots.
    }
  }
  return zips;
}

function findNapcatConfigDir(shellDir: string): string | null {
  const direct = [
    path.join(shellDir, "napcat", "config"),
    path.join(shellDir, "config")
  ];
  for (const item of direct) {
    if (fs.existsSync(item)) return item;
  }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: shellDir, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 8) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (current.dir.replace(/\\/g, "/").endsWith("/resources/app/napcat/config")) {
      return current.dir;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return null;
}

function copyOrExtractNapcatTemplate(rootDir: string, targetDir: string): { workingDir: string; steps: string[] } {
  const steps: string[] = ["正在获取 NapCat 目录..."];
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  if (fs.existsSync(targetDir)) {
    const existingConfigDir = findNapcatConfigDir(targetDir);
    if (existingConfigDir) {
      steps.push(`复用已存在目录：${targetDir}`);
      return { workingDir: targetDir, steps };
    }
    const sourceDir = candidateNapcatShellDirs(rootDir)
      .filter((dir) => Boolean(findNapcatConfigDir(dir)))
      .find((dir) => path.resolve(dir).toLowerCase() !== path.resolve(targetDir).toLowerCase());
    if (sourceDir) {
      steps.push(`修复未完整的 NapCat Shell 目录：${targetDir}`);
      steps.push(`补齐 NapCat Shell：${sourceDir}`);
      fs.cpSync(sourceDir, targetDir, {
        recursive: true,
        force: true,
        errorOnExist: false
      });
      const repairedConfigDir = findNapcatConfigDir(targetDir);
      if (repairedConfigDir) return { workingDir: targetDir, steps };
    }
    throw new Error(`获取 NapCat 目录失败：${targetDir} 不完整，且未找到可用于修复的完整 NapCat Shell 模板。`);
  }

  const sourceDir = candidateNapcatShellDirs(rootDir).find((dir) => Boolean(findNapcatConfigDir(dir)));
  if (sourceDir) {
    steps.push(`复制 NapCat Shell：${sourceDir}`);
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    return { workingDir: targetDir, steps };
  }

  const sourceZip = candidateNapcatShellZips(rootDir)[0];
  if (sourceZip && process.platform === "win32") {
    steps.push(`解压 NapCat Shell：${sourceZip}`);
    fs.mkdirSync(targetDir, { recursive: true });
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      sourceZip,
      targetDir
    ], { stdio: "ignore" });
    const nested = candidateNapcatShellDirs(targetDir).find((dir) => path.resolve(dir).startsWith(path.resolve(targetDir)));
    return { workingDir: nested || targetDir, steps };
  }

  throw new Error("获取 NapCat 目录失败：未找到可用的 NapCat Shell 模板目录或 NapCat.Shell.zip。");
}

function writeManagedNapcatConfigs(instance: NapCatInstanceDefinition): { steps: string[]; loginUrl: string; webuiToken: string } {
  const steps = ["正在写入实例配置..."];
  const workingDir = instance.workingDir?.trim();
  if (!workingDir) throw new Error("写入实例配置失败：缺少 NapCat 工作目录。");
  const configDir = findNapcatConfigDir(workingDir);
  if (!configDir) throw new Error(`写入实例配置失败：未在 ${workingDir} 找到 napcat/config 目录。`);
  fs.mkdirSync(configDir, { recursive: true });

  const webuiPath = path.join(configDir, "webui.json");
  const existingWebui = fs.existsSync(webuiPath)
    ? JSON.parse(fs.readFileSync(webuiPath, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const webuiPort = portFromUrl(instance.webuiUrl) || 6099;
  const webuiToken = newToken();
  fs.writeFileSync(webuiPath, JSON.stringify({
    ...existingWebui,
    host: existingWebui.host || "::",
    port: webuiPort,
    token: webuiToken,
    disableWebUI: false
  }, null, 2), "utf8");
  steps.push(`WebUI 端口：${webuiPort}`);

  const httpPort = portFromUrl(instance.httpUrl) || 3000;
  const wsUrl = `ws://127.0.0.1:${instance.gatewayPort}`;
  const onebotPath = path.join(configDir, `onebot11_rabiroute_${instance.id}.json`);
  fs.writeFileSync(onebotPath, JSON.stringify({
    network: {
      httpServers: [{
        enable: true,
        name: "RabiRoute HTTP",
        host: "127.0.0.1",
        port: httpPort,
        enableCors: true,
        enableWebsocket: false,
        messagePostFormat: "array",
        token: instance.accessToken || "",
        debug: false
      }],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [{
        enable: true,
        name: "RabiRoute",
        url: wsUrl,
        reportSelfMessage: false,
        messagePostFormat: "array",
        token: "",
        debug: false,
        heartInterval: 30000,
        reconnectInterval: 30000,
        verifyCertificate: true
      }],
      plugins: []
    }
  }, null, 2), "utf8");
  steps.push(`HTTP 端口：${httpPort}`);
  steps.push(`WS 地址：${wsUrl}`);
  return {
    steps,
    loginUrl: napcatWebuiLoginUrl(instance.webuiUrl || localUrl(webuiPort, "/webui"), webuiToken),
    webuiToken
  };
}

export function prepareManagedNapcatInstance(ctx: NapcatManagerContext, request: ManagedNapcatPrepareRequest): ManagedNapcatPrepareResult {
  const targetDir = path.join(ctx.rootDir, "data", "napcat", request.id, "NapCat.Shell");
  const prepared = copyOrExtractNapcatTemplate(ctx.rootDir, targetDir);
  const instance: NapCatInstanceDefinition = {
    id: request.id,
    name: request.name,
    enabled: true,
    gatewayPort: request.gatewayPort,
    httpUrl: localUrl(request.httpPort),
    webuiUrl: localUrl(request.webuiPort, "/webui"),
    accessToken: "",
    webuiToken: "",
    launchCommand: "napcat.bat",
    workingDir: prepared.workingDir
  };
  const written = writeManagedNapcatConfigs(instance);
  instance.webuiToken = written.webuiToken;
  return {
    instance,
    steps: [...prepared.steps, ...written.steps],
    loginUrl: written.loginUrl
  };
}

async function portIsFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function nextFreeLocalPort(preferred: number, used = new Set<number>()): Promise<number> {
  let port = Number.isInteger(preferred) && preferred > 0 ? preferred : 3000;
  while (port <= 65535) {
    if (!used.has(port) && await portIsFree(port)) {
      used.add(port);
      return port;
    }
    port += 1;
  }
  throw new Error("没有可用端口了。");
}

async function listeningPidsForPorts(ports: number[]): Promise<string[]> {
  const wanted = new Set(ports.filter((port) => Number.isInteger(port) && port > 0).map(String));
  if (wanted.size === 0 || process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 3000 });
    const pids = new Set<string>();
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const pid = parts[parts.length - 1] || "";
      const match = local.match(/:(\d+)$/);
      if (match && wanted.has(match[1]) && /^\d+$/.test(pid)) {
        pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function napcatWebuiLoginUrl(webuiUrl: string, token: string): string {
  try {
    const parsed = new URL(webuiUrl);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const separator = webuiUrl.includes("?") ? "&" : "?";
    return `${webuiUrl}${separator}token=${encodeURIComponent(token)}`;
  }
}

function addNapcatWebuiConfigCandidate(candidates: Set<string>, candidate: string | undefined): void {
  const value = candidate?.trim();
  if (!value) return;
  candidates.add(path.resolve(value));
}

function runtimeUsesNapcat(definition: GatewayDefinition): boolean {
  if (definition.messageInputsDisabled) return false;
  if (definition.messageAdaptersDisabled?.includes("napcat")) return false;
  if (definition.messageAdapterPolicies?.napcat?.inputEnabled === false) return false;
  const adapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  return adapters.includes("napcat");
}

function napcatInstancesFor(ctx: NapcatManagerContext, runtime: GatewayRuntime): NapCatInstanceDefinition[] {
  return runtime.definition.napcatInstances ?? ctx.normalizeNapCatInstances(runtime.definition);
}

function napcatRuntimes(ctx: NapcatManagerContext): GatewayRuntime[] {
  return [...ctx.getRuntimes()].filter((runtime) => runtimeUsesNapcat(runtime.definition));
}

function addNapcatWebuiConfigCandidatesForInstance(candidates: Set<string>, ctx: NapcatManagerContext, instance: NapCatInstanceDefinition): void {
  const workingDir = instance.workingDir?.trim();
  if (workingDir) {
    addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "napcat", "config", "webui.json"));
    addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "config", "webui.json"));
    addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "webui.json"));
    const nestedConfigDir = findNapcatConfigDir(workingDir);
    if (nestedConfigDir) {
      addNapcatWebuiConfigCandidate(candidates, path.join(nestedConfigDir, "webui.json"));
    }
  }
  const launchCommand = instance.launchCommand?.trim();
  if (launchCommand) {
    const commandPath = launchCommand.match(/^"([^"]+)"/)?.[1] || launchCommand.split(/\s+/)[0];
    if (commandPath && (commandPath.includes("\\") || commandPath.includes("/"))) {
      const commandDir = path.dirname(path.resolve(workingDir || ctx.rootDir, commandPath));
      addNapcatWebuiConfigCandidate(candidates, path.join(commandDir, "napcat", "config", "webui.json"));
      addNapcatWebuiConfigCandidate(candidates, path.join(commandDir, "config", "webui.json"));
    }
  }
}

function napcatWebuiConfigCandidates(ctx: NapcatManagerContext, preferredInstances: NapCatInstanceDefinition[] = []): string[] {
  const candidates = new Set<string>();
  addNapcatWebuiConfigCandidate(candidates, process.env.NAPCAT_WEBUI_CONFIG);
  if (process.env.NAPCAT_CONFIG_DIR) {
    addNapcatWebuiConfigCandidate(candidates, path.join(process.env.NAPCAT_CONFIG_DIR, "webui.json"));
  }

  for (const instance of preferredInstances) {
    addNapcatWebuiConfigCandidatesForInstance(candidates, ctx, instance);
  }

  for (const runtime of ctx.getRuntimes()) {
    for (const instance of napcatInstancesFor(ctx, runtime)) {
      addNapcatWebuiConfigCandidatesForInstance(candidates, ctx, instance);
    }
  }

  const searchRoots = [
    path.resolve(ctx.rootDir, "data", "napcat"),
    path.resolve(ctx.rootDir, "..", "NapCat"),
    path.resolve(ctx.rootDir, "..", "tools", "NapCat"),
    path.resolve(ctx.rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat"),
    path.resolve(os.homedir(), "AppData", "Local", "NapCat")
  ];
  for (const base of searchRoots) {
    try {
      if (!fs.existsSync(base)) continue;
      addNapcatWebuiConfigCandidate(candidates, path.join(base, "napcat", "config", "webui.json"));
      addNapcatWebuiConfigCandidate(candidates, path.join(base, "config", "webui.json"));
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "napcat", "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "NapCat.Shell", "napcat", "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "NapCat.Shell", "config", "webui.json"));
        const nestedConfigDir = findNapcatConfigDir(dir);
        if (nestedConfigDir) {
          addNapcatWebuiConfigCandidate(candidates, path.join(nestedConfigDir, "webui.json"));
        }
      }
    } catch {
      // Ignore inaccessible candidate roots.
    }
  }

  return [...candidates].filter((candidate) => fs.existsSync(candidate));
}

function preferredNapcatInstancesForHealth(ctx: NapcatManagerContext, request: NapcatHealthRequest): NapCatInstanceDefinition[] {
  const result: NapCatInstanceDefinition[] = [];
  for (const runtime of ctx.getRuntimes()) {
    if (request.gatewayId && runtime.definition.id !== request.gatewayId) continue;
    for (const instance of napcatInstancesFor(ctx, runtime)) {
      const matchesInstanceId = request.instanceId && instance.id === request.instanceId;
      const matchesHttp = request.httpUrl && instance.httpUrl === request.httpUrl;
      const matchesWebui = request.webuiUrl && instance.webuiUrl === request.webuiUrl;
      const matchesGatewayPort = request.gatewayPort && Number(instance.gatewayPort || 0) === Number(request.gatewayPort);
      if (matchesInstanceId || (!request.instanceId && (matchesHttp || matchesWebui || matchesGatewayPort))) {
        result.push(instance);
      }
    }
  }
  return result;
}

function readNapcatWebuiToken(ctx: NapcatManagerContext, webuiUrl: string, providedToken?: string, preferredInstances: NapCatInstanceDefinition[] = []): NapcatWebuiTokenInfo {
  const provided = providedToken?.trim();
  let expectedPort = 0;
  try {
    expectedPort = Number(new URL(webuiUrl).port || 6099);
  } catch {
    expectedPort = 0;
  }

  const candidates = napcatWebuiConfigCandidates(ctx, preferredInstances);
  let fallback: NapcatWebuiTokenInfo | null = provided
    ? {
        found: true,
        token: provided,
        tokenLength: provided.length,
        loginUrl: napcatWebuiLoginUrl(webuiUrl, provided),
        source: "provided"
      }
    : null;
  for (const configPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as { token?: unknown; port?: unknown; disableWebUI?: unknown };
      const fileToken = String(parsed.token || "").trim();
      const token = fileToken || provided || "";
      if (!token || parsed.disableWebUI === true) continue;
      const port = Number(parsed.port || 0);
      const correctedWebuiUrl = port && port !== expectedPort
        ? localWebuiUrlWithPort(webuiUrl, port)
        : "";
      const info: NapcatWebuiTokenInfo = {
        found: true,
        token,
        tokenLength: token.length,
        configPath,
        ...(port ? { configPort: port } : {}),
        ...(correctedWebuiUrl ? { correctedWebuiUrl } : {}),
        loginUrl: napcatWebuiLoginUrl(webuiUrl, token),
        source: fileToken ? "config" : "provided"
      };
      if (!fallback) fallback = info;
      if (!expectedPort || !port || port === expectedPort) {
        return info;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return fallback ?? {
    found: false,
    message: candidates.length
      ? "已找到 NapCat webui.json，但没有读到可用 token。"
      : "未找到 NapCat config/webui.json；可在 NapCat 启动日志里查看 WebUI token。"
  };
}

function napcatWebuiBaseUrl(webuiUrl: string): string {
  return webuiUrl.replace(/\/webui\/?$/i, "").replace(/\/+$/, "");
}

async function loginNapcatWebui(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo): Promise<NapcatWebuiSession | null> {
  const token = tokenInfo.token?.trim();
  if (!token) return null;
  const baseUrl = napcatWebuiBaseUrl(webuiUrl);
  const hash = createHash("sha256").update(`${token}.napcat`).digest("hex");
  const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ hash })
  });
  const loginBody = await loginResp.json().catch(() => ({})) as NapcatWebuiResponse<{ Credential?: string }>;
  const credential = String(loginBody.data?.Credential || "").trim();
  if (!loginResp.ok || loginBody.code !== 0 || !credential) return null;
  return { baseUrl, credential };
}

async function readNapcatWebuiLoginInfo(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo): Promise<NapcatLoginInfo | null> {
  const session = await loginNapcatWebui(webuiUrl, tokenInfo);
  if (!session) return null;

  const infoResp = await fetch(`${session.baseUrl}/api/QQLogin/GetQQLoginInfo`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${session.credential}`
    },
    body: "{}"
  });
  const infoBody = await infoResp.json().catch(() => ({})) as NapcatWebuiResponse<{ uin?: string | number; nick?: string; online?: boolean }>;
  if (!infoResp.ok || infoBody.code !== 0 || !infoBody.data?.uin) return null;
  return {
    userId: infoBody.data.uin,
    nickname: infoBody.data.nick,
    online: infoBody.data.online,
    source: "webui"
  };
}

function normalizeOneBotNetworkConfig(config: NapcatOneBotNetworkConfig): NormalizedNapcatOneBotNetworkConfig {
  const network = config.network ?? {};
  return {
    network: {
      httpServers: Array.isArray(network.httpServers) ? network.httpServers : [],
      httpSseServers: Array.isArray(network.httpSseServers) ? network.httpSseServers : [],
      httpClients: Array.isArray(network.httpClients) ? network.httpClients : [],
      websocketServers: Array.isArray(network.websocketServers) ? network.websocketServers : [],
      websocketClients: Array.isArray(network.websocketClients) ? network.websocketClients : [],
      plugins: Array.isArray(network.plugins) ? network.plugins : []
    }
  };
}

function upsertByNameOrEndpoint(items: Array<Record<string, unknown>>, next: Record<string, unknown>, endpointKey: "port" | "url"): boolean {
  const wantedName = String(next.name || "");
  const wantedEndpoint = next[endpointKey];
  const index = items.findIndex((item) =>
    String(item.name || "") === wantedName ||
    (wantedEndpoint != null && item[endpointKey] === wantedEndpoint)
  );
  if (index >= 0) {
    const merged = { ...items[index], ...next };
    const changed = JSON.stringify(items[index]) !== JSON.stringify(merged);
    items[index] = merged;
    return changed;
  }
  items.push(next);
  return true;
}

function onebotConfigPathForWebuiConfig(configPath: string | undefined, userId: string | number | undefined): string | null {
  const uin = String(userId || "").trim();
  if (!configPath || !uin) return null;
  return path.join(path.dirname(configPath), `onebot11_${uin}.json`);
}

function readOneBotNetworkConfig(configPath: string | null): NormalizedNapcatOneBotNetworkConfig | null {
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as NapcatOneBotNetworkConfig;
    return normalizeOneBotNetworkConfig(parsed);
  } catch {
    return null;
  }
}

function isEnabledConfigItem(item: Record<string, unknown>): boolean {
  return item.enable !== false && item.enabled !== false;
}

function onebotConfigMatches(config: NormalizedNapcatOneBotNetworkConfig | null, httpPort: number, wsUrl: string): boolean {
  if (!config) return false;
  const hasHttp = config.network.httpServers.some((item) =>
    isEnabledConfigItem(item) && Number(item.port || 0) === httpPort
  );
  const hasWs = config.network.websocketClients.some((item) =>
    isEnabledConfigItem(item) && String(item.url || "").trim() === wsUrl
  );
  return hasHttp && hasWs;
}

async function napcatHttpOk(httpUrl: string, token: string | undefined, timeoutMs = 4000): Promise<boolean> {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${httpUrl.replace(/\/+$/, "")}/get_login_info`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({})) as NapcatOneBotResponse<unknown>;
    return body.retcode == null || body.retcode === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function napcatStatusEndpointOk(httpUrl: string | undefined, token: string | undefined, timeoutMs = 3000): Promise<boolean> {
  const url = httpUrl?.trim();
  if (!url) return false;
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/get_status`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({})) as NapcatOneBotResponse<{ online?: boolean; good?: boolean }>;
    if (body.retcode != null && body.retcode !== 0) return false;
    return body.data?.online !== false && body.data?.good !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForNapcatReady(ctx: NapcatManagerContext, instance: NapCatInstanceDefinition, timeoutMs = 35000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  const httpUrl = instance.httpUrl?.trim();
  const webuiUrl = instance.webuiUrl?.trim();
  let webuiReachable = false;
  while (Date.now() < deadline) {
    if (await napcatStatusEndpointOk(httpUrl, instance.accessToken, 2500)) {
      return { ok: true, kind: "onebot-status", url: `${httpUrl?.replace(/\/+$/, "")}/get_status` };
    }
    if (!httpUrl && webuiUrl && await ctx.checkHttpEndpoint(webuiUrl, 1200)) {
      return { ok: true, kind: "webui", url: webuiUrl };
    }
    if (httpUrl && webuiUrl && !webuiReachable) {
      webuiReachable = await ctx.checkHttpEndpoint(webuiUrl, 1200);
    }
    await wait(1000);
  }
  return {
    ok: false,
    kind: "timeout",
    webuiReachable,
    message: httpUrl
      ? `启动命令已执行，${webuiUrl && webuiReachable ? "NapCat WebUI 可达，但 " : ""}${httpUrl.replace(/\/+$/, "")}/get_status 未在超时时间内返回 online/good。`
      : `启动命令已执行，但等待 ${webuiUrl || "NapCat WebUI"} 可达超时。`
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function applyOneBotConfigViaWebui(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo, config: NormalizedNapcatOneBotNetworkConfig): Promise<string[]> {
  const session = await loginNapcatWebui(webuiUrl, tokenInfo);
  if (!session) return ["未能登录 NapCat WebUI，无法调用 WebUI API 应用配置。"];
  const steps: string[] = [];
  const setResp = await fetch(`${session.baseUrl}/api/OB11Config/SetConfig`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${session.credential}`
    },
    body: JSON.stringify({ config: JSON.stringify(config) })
  });
  const setBody = await setResp.json().catch(() => ({})) as NapcatWebuiResponse<unknown>;
  if (setResp.ok && setBody.code === 0) {
    steps.push("已通过 NapCat WebUI API 保存/应用 OB11 网络配置。");
  } else {
    steps.push(`NapCat WebUI 保存配置失败：${setBody.message || setResp.statusText || setResp.status}`);
  }
  return steps;
}

async function restartNapcatViaWebui(webuiUrl: string, tokenInfo: NapcatWebuiTokenInfo): Promise<string[]> {
  const session = await loginNapcatWebui(webuiUrl, tokenInfo);
  if (!session) return ["未能登录 NapCat WebUI，无法调用重启接口。"];
  const steps: string[] = [];
  for (const endpoint of ["/api/QQLogin/RestartNapCat", "/api/Process/Restart"]) {
    const resp = await fetch(`${session.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${session.credential}`
      },
      body: "{}"
    });
    const body = await resp.json().catch(() => ({})) as NapcatWebuiResponse<{ message?: string }>;
    if (resp.ok && body.code === 0) {
      steps.push(`已调用 NapCat 重启接口：${body.data?.message || body.message || endpoint}`);
      return steps;
    }
    steps.push(`NapCat 重启接口 ${endpoint} 未成功：${body.message || resp.statusText || resp.status}`);
  }
  return steps;
}

async function requestNapcatBotExit(httpUrl: string | undefined, token: string | undefined): Promise<string[]> {
  const url = httpUrl?.trim();
  if (!url) return [];
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token?.trim()) headers.authorization = `Bearer ${token.trim()}`;
  const steps: string[] = [];
  try {
    const resp = await fetch(`${url.replace(/\/+$/, "")}/bot_exit`, {
      method: "POST",
      headers,
      body: "{}"
    });
    const body = await resp.json().catch(() => ({})) as NapcatOneBotResponse<unknown>;
    if (resp.ok && (body.retcode == null || body.retcode === 0)) {
      steps.push("已调用 OneBot bot_exit，要求该 QQ/NapCat 退出。");
    } else {
      steps.push(`OneBot bot_exit 未成功：${body.wording || body.message || resp.statusText || resp.status}`);
    }
  } catch (error) {
    steps.push(`OneBot bot_exit 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
  return steps;
}

async function logoutNapcatWebui(webuiUrl: string | undefined, tokenInfo: NapcatWebuiTokenInfo): Promise<string[]> {
  const url = webuiUrl?.trim();
  if (!url || !tokenInfo.token) return [];
  const session = await loginNapcatWebui(url, tokenInfo).catch(() => null);
  if (!session) return ["未能登录 NapCat WebUI，跳过 WebUI 会话退出。"];
  try {
    const resp = await fetch(`${session.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${session.credential}`
      },
      body: "{}"
    });
    const body = await resp.json().catch(() => ({})) as NapcatWebuiResponse<unknown>;
    return resp.ok && body.code === 0
      ? ["已退出 NapCat WebUI 会话。"]
      : [`NapCat WebUI 会话退出未成功：${body.message || resp.statusText || resp.status}`];
  } catch (error) {
    return [`NapCat WebUI 会话退出失败：${error instanceof Error ? error.message : String(error)}`];
  }
}

function managedNapcatInstanceRoot(ctx: NapcatManagerContext, workingDir: string | undefined): string | null {
  const value = workingDir?.trim();
  if (!value) return null;
  const managedRoot = path.resolve(ctx.rootDir, "data", "napcat");
  let current = path.resolve(value);
  for (let i = 0; i < 8; i += 1) {
    if (path.basename(current).toLowerCase() === "napcat.shell") {
      const parent = path.dirname(current);
      const relative = path.relative(managedRoot, parent);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return parent;
      }
      return null;
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return null;
}

function removeManagedNapcatFiles(ctx: NapcatManagerContext, instance: NapCatInstanceDefinition): string[] {
  const root = managedNapcatInstanceRoot(ctx, instance.workingDir);
  if (!root || !fs.existsSync(root)) return [];
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return [`已删除受管 NapCat 实例目录：${root}`];
  } catch (error) {
    return [`受管 NapCat 实例目录暂时无法删除：${error instanceof Error ? error.message : String(error)}`];
  }
}

async function waitForPortsReleased(ports: number[], timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await listeningPidsForPorts(ports);
    if (pids.length === 0) return;
    await wait(300);
  }
}

async function windowsPidsForCommandLineNeedle(needle: string | null): Promise<string[]> {
  if (process.platform !== "win32" || !needle) return [];
  const normalized = path.resolve(needle).replace(/\//g, "\\").toLowerCase();
  const quotedNeedle = normalized.replace(/'/g, "''");
  try {
    const script = [
      `$needle = '${quotedNeedle}'`,
      "Get-CimInstance Win32_Process |",
      "Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) } |",
      "Select-Object -ExpandProperty ProcessId"
    ].join(" ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 5000 });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

async function napcatInstanceProcessPids(ctx: NapcatManagerContext, instance: NapCatInstanceDefinition, ports: number[]): Promise<string[]> {
  const pids = new Set<string>(await listeningPidsForPorts(ports));
  const managedRoot = managedNapcatInstanceRoot(ctx, instance.workingDir);
  for (const pid of await windowsPidsForCommandLineNeedle(managedRoot || instance.workingDir || null)) {
    pids.add(pid);
  }
  return [...pids];
}

export async function configureNapcatOneBot(ctx: NapcatManagerContext, request: NapcatConfigureRequest): Promise<Record<string, unknown>> {
  const httpUrl = (request.httpUrl?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const webuiUrl = request.webuiUrl?.trim() || "http://127.0.0.1:6099/webui";
  const gatewayPort = Number(request.gatewayPort || 0);
  const httpPort = portFromUrl(httpUrl);
  if (!httpPort) throw new Error(`无法从 HTTP 地址解析端口：${httpUrl}`);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
    throw new Error(`RabiRoute WS 端口无效：${request.gatewayPort || ""}`);
  }

  const tokenInfo = readNapcatWebuiToken(ctx, webuiUrl, request.webuiToken);
  const webuiLoginInfo = await readNapcatWebuiLoginInfo(webuiUrl, tokenInfo);
  const onebotPath = onebotConfigPathForWebuiConfig(tokenInfo.configPath, webuiLoginInfo?.userId);
  if (!tokenInfo.configPath || !onebotPath || !webuiLoginInfo?.userId) {
    throw new Error(tokenInfo.message || "无法确定当前登录 QQ 对应的 NapCat OneBot 配置文件。");
  }

  let parsed: NapcatOneBotNetworkConfig = {};
  if (fs.existsSync(onebotPath)) {
    parsed = JSON.parse(fs.readFileSync(onebotPath, "utf8").replace(/^\uFEFF/, "")) as NapcatOneBotNetworkConfig;
  }
  const config = normalizeOneBotNetworkConfig(parsed);
  const wsUrl = `ws://127.0.0.1:${gatewayPort}`;
  const changedHttp = upsertByNameOrEndpoint(config.network.httpServers, {
    enable: true,
    name: "RabiRoute HTTP",
    host: "127.0.0.1",
    port: httpPort,
    enableCors: true,
    enableWebsocket: false,
    messagePostFormat: "array",
    token: request.accessToken?.trim() || "",
    debug: false
  }, "port");
  const changedWs = upsertByNameOrEndpoint(config.network.websocketClients, {
    enable: true,
    name: "RabiRoute",
    url: wsUrl,
    reportSelfMessage: false,
    messagePostFormat: "array",
    token: "",
    debug: false,
    heartInterval: 30000,
    reconnectInterval: 30000,
    verifyCertificate: true
  }, "url");

  fs.writeFileSync(onebotPath, JSON.stringify(config, null, 2), "utf8");
  const steps = [
    `已写入当前 QQ 的 OneBot 配置文件：HTTP ${httpPort}，WS ${wsUrl}。`
  ];
  steps.push(...await applyOneBotConfigViaWebui(webuiUrl, tokenInfo, config));
  await wait(1200);
  let httpReady = await napcatHttpOk(httpUrl, request.accessToken, 3000);
  let restartRequested = false;
  if (!httpReady) {
    steps.push("保存/应用后 HTTP 仍未开放，正在调用 NapCat 重启接口。");
    steps.push(...await restartNapcatViaWebui(webuiUrl, tokenInfo));
    restartRequested = true;
    for (let i = 0; i < 12; i += 1) {
      await wait(1500);
      httpReady = await napcatHttpOk(httpUrl, request.accessToken, 2500);
      if (httpReady) break;
    }
  }
  return {
    ok: true,
    changed: changedHttp || changedWs,
    reloadRequired: !httpReady,
    restartRequested,
    httpReady,
    steps,
    message: httpReady
      ? `已为当前登录 QQ ${webuiLoginInfo.userId} 写入并应用 OneBot HTTP ${httpPort} 和 WS ${wsUrl}。`
      : `已为当前登录 QQ ${webuiLoginInfo.userId} 写入 OneBot HTTP ${httpPort} 和 WS ${wsUrl}，并已尝试让 NapCat 应用配置；请稍后复查。`,
    userId: webuiLoginInfo.userId,
    nickname: webuiLoginInfo.nickname,
    configPath: onebotPath,
    httpUrl,
    wsUrl
  };
}

export async function testNapcatHealth(ctx: NapcatManagerContext, request: NapcatHealthRequest): Promise<Record<string, unknown>> {
  const httpUrl = (request.httpUrl?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const webuiUrl = request.webuiUrl?.trim() || "http://127.0.0.1:6099/webui";
  const token = request.accessToken?.trim() || "";
  const gatewayPort = Number(request.gatewayPort || 0);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let http: Record<string, unknown>;
  let loginInfo: NapcatLoginInfo | null = null;
  let onebotStatus: { online?: boolean; good?: boolean } | null = null;
  try {
    const statusResponse = await fetch(`${httpUrl}/get_status`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    const statusBody = await statusResponse.json().catch(() => ({})) as NapcatOneBotResponse<{ online?: boolean; good?: boolean }>;
    if (statusResponse.ok && (statusBody.retcode == null || statusBody.retcode === 0)) {
      onebotStatus = statusBody.data ?? null;
    }
    const response = await fetch(`${httpUrl}/get_login_info`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    const text = await response.text();
    let body: NapcatOneBotResponse<{ user_id?: number | string; nickname?: string }> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    const failed = !response.ok
      || (body.retcode != null && body.retcode !== 0)
      || body.status === "failed";
    if (failed) {
      http = {
        ok: false,
        status: response.status,
        message: body.wording || body.message || text || `HTTP ${response.status}`
      };
    } else {
      http = {
        ok: true,
        status: response.status,
        userId: body.data?.user_id,
        nickname: body.data?.nickname,
        online: onebotStatus?.online,
        good: onebotStatus?.good
      };
      loginInfo = {
        userId: body.data?.user_id,
        nickname: body.data?.nickname,
        online: onebotStatus?.online,
        source: "onebot-http"
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    http = { ok: false, status: 0, message: message.includes("abort") ? "NapCat HTTP 检查超时。" : message };
  } finally {
    clearTimeout(timer);
  }

  const preferredInstances = preferredNapcatInstancesForHealth(ctx, request);
  let tokenInfo = readNapcatWebuiToken(ctx, webuiUrl, request.webuiToken, preferredInstances);
  let effectiveWebuiUrl = webuiUrl;
  let webuiReachable = await ctx.checkHttpEndpoint(webuiUrl, 1600);
  const correctedWebuiUrl = tokenInfo.correctedWebuiUrl?.trim();
  if (!webuiReachable && correctedWebuiUrl && correctedWebuiUrl !== webuiUrl) {
    const correctedReachable = await ctx.checkHttpEndpoint(correctedWebuiUrl, 1600);
    if (correctedReachable) {
      effectiveWebuiUrl = correctedWebuiUrl;
      webuiReachable = true;
      tokenInfo = {
        ...tokenInfo,
        loginUrl: tokenInfo.token ? napcatWebuiLoginUrl(effectiveWebuiUrl, tokenInfo.token) : tokenInfo.loginUrl
      };
    }
  }
  let webuiLoginInfo: NapcatLoginInfo | null = null;
  try {
    webuiLoginInfo = await readNapcatWebuiLoginInfo(effectiveWebuiUrl, tokenInfo);
    if (!loginInfo && webuiLoginInfo) loginInfo = webuiLoginInfo;
  } catch {
    webuiLoginInfo = null;
  }
  const webui = {
    url: effectiveWebuiUrl,
    configuredUrl: webuiUrl,
    correctedUrl: effectiveWebuiUrl !== webuiUrl ? effectiveWebuiUrl : undefined,
    reachable: webuiReachable,
    ...tokenInfo,
    loginInfo: webuiLoginInfo
  };
  const onebotPath = onebotConfigPathForWebuiConfig(tokenInfo.configPath, webuiLoginInfo?.userId);
  const httpPort = portFromUrl(httpUrl);
  const wsUrl = gatewayPort > 0 ? `ws://127.0.0.1:${gatewayPort}` : "";
  const onebotConfig = readOneBotNetworkConfig(onebotPath);
  const onebotConfigured = onebotConfigMatches(onebotConfig, httpPort, wsUrl);
  const diagnostics: string[] = [];
  if (http.ok && onebotStatus?.online === false) {
    diagnostics.push(`${httpUrl}/get_status 返回 online:false；WS 或登录资料可能仍有旧连接，但 QQ 实际已经离线。`);
  }
  if (http.ok && onebotStatus?.good === false) {
    diagnostics.push(`${httpUrl}/get_status 返回 good:false；NapCat 进程仍在，但 OneBot 当前不可健康投递。`);
  }
  if (!http.ok && webuiLoginInfo?.userId) {
    diagnostics.push(`当前 WebUI 登录 QQ ${webuiLoginInfo.userId}，但 ${httpUrl}/get_login_info 不可用。`);
    if (onebotConfigured) {
      diagnostics.push(`当前 QQ 的 OneBot 配置文件已包含 HTTP ${httpPort} 和 WS ${wsUrl}，但运行中的 NapCat 还没有开放 HTTP。`);
      diagnostics.push("请在 NapCat WebUI 保存/重载网络配置，或重启这个 NapCat 后再复查。");
    } else {
      diagnostics.push(`通常是这个 QQ 的 OneBot HTTP Server 没启用，或端口没有配置为 ${httpPort}。`);
    }
  }
  if (gatewayPort > 0 && webuiLoginInfo?.userId) {
    diagnostics.push(`请确认当前 QQ 的 WebSocket Client 指向 ws://127.0.0.1:${gatewayPort}。`);
  }
  const fixAvailable = Boolean(!http.ok && webuiLoginInfo?.userId && tokenInfo.configPath && onebotPath);
  const processes = await detectNapcatProcesses();
  return {
    ok: Boolean(http.ok && onebotStatus?.online !== false && onebotStatus?.good !== false),
    fixAvailable,
    diagnostics,
    message: !http.ok && webuiLoginInfo?.userId
      ? onebotConfigured
        ? `已为当前 QQ ${webuiLoginInfo.userId} 写入 OneBot HTTP/WS 配置，但 NapCat 尚未重载生效，可一键尝试应用/重启 NapCat。`
        : `WebUI 已登录 ${webuiLoginInfo.userId}，但 OneBot HTTP 未连通，可一键写入当前 QQ 的 HTTP/WS 配置。`
      : undefined,
    http,
    webui,
    loginInfo,
    onebot: {
      configPath: onebotPath,
      currentUserId: webuiLoginInfo?.userId,
      currentNickname: webuiLoginInfo?.nickname
    },
    gatewayPort,
    wsUrl,
    process: {
      found: processes.length > 0,
      candidates: processes.slice(0, 8)
    }
  };
}

export async function launchNapcatInstance(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) {
    throw new Error("缺少 gatewayId 或 instanceId。");
  }
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) {
    throw new Error(`未找到路由：${gatewayId}`);
  }
  const instance = napcatInstancesFor(ctx, runtime)
    .find((item) => item.id === instanceId);
  if (!instance) {
    throw new Error(`未找到 NapCat 实例：${instanceId}`);
  }
  const plan = resolveNapcatLaunchPlan(instance, ctx.rootDir);
  if (process.platform === "win32") {
    launchHiddenOnWindows(plan);
  } else {
    const child = spawn(plan.commandLine, [], {
      cwd: plan.cwd,
      detached: true,
      shell: true,
      stdio: "ignore"
    });
    child.unref();
  }
  const ready = await waitForNapcatReady(ctx, instance);
  const readyOk = ready.ok !== false;
  ctx.appendLog(runtime, `launch NapCat instance ${instance.name || instance.id}: ${plan.commandLine} ready=${readyOk ? String(ready.kind || "ok") : "timeout"}`);
  const steps = [
    ...(plan.redirectedFromOuterShell ? [`已识别外层 NapCat Shell，改用内层启动器：${plan.commandPath}`] : []),
    ...(plan.botUserId && plan.redirectedFromOuterShell ? [`已追加 quick login 参数：-q ${plan.botUserId}`] : []),
    ...plan.warnings,
    readyOk ? `NapCat 已可达：${ready.url || ready.kind || "health"}` : String(ready.message || "NapCat 健康检查超时。")
  ];
  return {
    ok: readyOk,
    message: readyOk
      ? `已启动 NapCat：${instance.name || instance.id}`
      : `NapCat 启动命令已执行，但后台未在超时时间内可达：${instance.name || instance.id}`,
    steps,
    health: ready,
    launchCommand: plan.commandLine,
    instance: {
      id: instance.id,
      name: instance.name,
      gatewayPort: instance.gatewayPort,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl
    }
  };
}

export async function restartNapcatInstance(ctx: NapcatManagerContext, request: NapcatLaunchRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) {
    throw new Error("缺少 gatewayId 或 instanceId。");
  }
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) {
    throw new Error(`未找到路由：${gatewayId}`);
  }
  const instance = napcatInstancesFor(ctx, runtime).find((item) => item.id === instanceId);
  if (!instance) {
    throw new Error(`未找到 NapCat 实例：${instanceId}`);
  }

  const steps: string[] = [];
  let restartedViaWebui = false;
  if (instance.webuiUrl) {
    const tokenInfo = readNapcatWebuiToken(ctx, instance.webuiUrl, instance.webuiToken);
    const webuiSteps = await restartNapcatViaWebui(instance.webuiUrl, tokenInfo);
    restartedViaWebui = webuiSteps.some((step) => step.startsWith("已调用 NapCat 重启接口"));
    steps.push(...webuiSteps);
    if (restartedViaWebui) {
      await wait(1500);
    }
  }

  const ports = [
    portFromUrl(instance.httpUrl),
    portFromUrl(instance.webuiUrl)
  ].filter((port) => Number.isInteger(port) && port > 0);
  const stopped: string[] = [];
  let launchResult: Record<string, unknown> | null = null;
  let ready: Record<string, unknown> | null = null;
  if (restartedViaWebui) {
    ready = await waitForNapcatReady(ctx, instance);
    steps.push(ready.ok !== false
      ? `NapCat 重启后已可达：${ready.url || ready.kind || "health"}`
      : String(ready.message || "NapCat 重启后健康检查超时。"));
    if (ready.ok === false) {
      steps.push("WebUI 重启后 OneBot 仍未在线，改用进程级硬重启。");
      restartedViaWebui = false;
    }
  }

  if (!restartedViaWebui) {
    const pids = await napcatInstanceProcessPids(ctx, instance, ports);
    for (const pid of pids) {
      try {
        await execFileAsync("taskkill.exe", ["/PID", pid, "/T", "/F"], { timeout: 5000 });
        stopped.push(pid);
      } catch {
        steps.push(`停止 PID ${pid} 失败，已跳过。`);
      }
    }
    if (stopped.length) {
      steps.push(`已停止旧 NapCat 进程：${stopped.join(", ")}`);
      await waitForPortsReleased(ports, 2000);
    }
  }

  if (!restartedViaWebui) {
    if (!instance.launchCommand?.trim()) {
      steps.push("没有启动命令，无法在 WebUI 重启失败后自动拉起后台。");
    } else {
      launchResult = await launchNapcatInstance(ctx, request);
      steps.push(String(launchResult.message || "已尝试启动 NapCat 后台。"));
    }
  }

  const ok = restartedViaWebui
    ? Boolean(ready && ready.ok !== false)
    : Boolean(launchResult && launchResult.ok !== false);
  ctx.appendLog(runtime, `restart NapCat instance ${instance.name || instance.id}: webui=${restartedViaWebui ? "ok" : "skipped"} stopped=${stopped.join(",") || "none"} launched=${launchResult ? "yes" : "no"} ready=${ready ? String(ready.kind || ready.ok) : String(launchResult?.health ? (launchResult.health as Record<string, unknown>).kind || (launchResult.health as Record<string, unknown>).ok : "none")}`);
  return {
    ok,
    message: ok
      ? `已重启 NapCat：${instance.name || instance.id}`
      : `已执行 NapCat 重启流程，但后台未在超时时间内可达：${instance.name || instance.id}`,
    steps,
    stoppedPids: stopped,
    launch: launchResult,
    health: ready ?? launchResult?.health,
    instance: {
      id: instance.id,
      name: instance.name,
      gatewayPort: instance.gatewayPort,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl
    }
  };
}

export async function stopNapcatInstance(ctx: NapcatManagerContext, request: NapcatStopRequest): Promise<Record<string, unknown>> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) {
    throw new Error("缺少 gatewayId 或 instanceId。");
  }
  const runtime = [...ctx.getRuntimes()].find((item) => item.definition.id === gatewayId);
  if (!runtime) {
    throw new Error(`未找到路由：${gatewayId}`);
  }
  const instance = napcatInstancesFor(ctx, runtime).find((item) => item.id === instanceId) ?? {
    id: instanceId,
    name: request.name,
    enabled: false,
    gatewayPort: Number(request.gatewayPort || 0),
    httpUrl: request.httpUrl || "",
    webuiUrl: request.webuiUrl,
    accessToken: request.accessToken,
    webuiToken: request.webuiToken,
    launchCommand: request.launchCommand,
    workingDir: request.workingDir
  };
  if (!instance) {
    throw new Error(`未找到 NapCat 实例：${instanceId}`);
  }

  const steps: string[] = [];
  steps.push(...await requestNapcatBotExit(instance.httpUrl, instance.accessToken));
  if (instance.webuiUrl) {
    const tokenInfo = readNapcatWebuiToken(ctx, instance.webuiUrl, instance.webuiToken);
    steps.push(...await logoutNapcatWebui(instance.webuiUrl, tokenInfo));
  }

  const ports = [
    portFromUrl(instance.httpUrl),
    portFromUrl(instance.webuiUrl)
  ].filter((port) => Number.isInteger(port) && port > 0);
  const stopped: string[] = [];
  const failed: string[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pids = (await napcatInstanceProcessPids(ctx, instance, ports)).filter((pid) => !stopped.includes(pid));
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        await execFileAsync("taskkill.exe", ["/PID", pid, "/T", "/F"], { timeout: 5000 });
        stopped.push(pid);
      } catch {
        failed.push(pid);
      }
    }
    await waitForPortsReleased(ports, 1500);
  }
  const remainingPids = await napcatInstanceProcessPids(ctx, instance, ports);
  if (remainingPids.length > 0) failed.push(...remainingPids.filter((pid) => !failed.includes(pid)));
  steps.push(...removeManagedNapcatFiles(ctx, instance));
  ctx.appendLog(runtime, `stop NapCat instance ${instance.name || instance.id}: ports=${ports.join(",")} stopped=${stopped.join(",") || "none"} remaining=${remainingPids.join(",") || "none"}`);
  return {
    ok: remainingPids.length === 0,
    message: stopped.length
      ? failed.length
        ? `已尝试停止 ${instance.name || instance.id}，但仍有 PID ${failed.join(", ")} 可能未退出。`
        : `已停止 NapCat 后台：${instance.name || instance.id}`
      : `未发现 ${instance.name || instance.id} 的监听进程，已继续移除配置。`,
    ports,
    steps,
    stoppedPids: stopped,
    failedPids: [...new Set(failed)]
  };
}

export async function scanNapcatEndpoint(ctx: NapcatManagerContext): Promise<MessageAdapterScanResult> {
  const napcatProcesses = await detectNapcatProcesses();
  const runtimes = napcatRuntimes(ctx);
  const napcatInstances = runtimes.flatMap((runtime) => napcatInstancesFor(ctx, runtime));
  const napcatWebuiEndpointRows = await Promise.all(napcatInstances.map(async (instance) => ({
    label: `${instance.name || instance.id} WebUI`,
    url: instance.webuiUrl || "http://127.0.0.1:6099/webui",
    healthy: await ctx.checkHttpEndpoint(instance.webuiUrl || "http://127.0.0.1:6099/webui", 1200)
  })));
  const napcatWebuiEndpoints = [...napcatWebuiEndpointRows.reduce((byUrl, endpoint) => {
    const existing = byUrl.get(endpoint.url);
    if (!existing || endpoint.healthy) byUrl.set(endpoint.url, endpoint);
    return byUrl;
  }, new Map<string, AdapterEndpoint>()).values()];
  const napcatWebuiToken = readNapcatWebuiToken(ctx, napcatWebuiEndpoints[0]?.url || "http://127.0.0.1:6099/webui");
  const napcatConnected = runtimes.some((runtime) => {
    const status = runtime.status ?? {};
    const instances = status.napcatInstances;
    if (instances && typeof instances === "object") {
      return Object.values(instances).some((item: any) => Boolean(item?.connected || item?.botUserId));
    }
    const napcat = status.napcat as { connected?: unknown; botUserId?: unknown } | undefined;
    return Boolean(napcat?.connected || napcat?.botUserId);
  });

  return {
    type: "napcat",
    label: "NapCat / OneBot",
    maturity: "verified",
    installed: napcatProcesses.length > 0 || napcatWebuiEndpoints.some((endpoint) => endpoint.healthy),
    installCandidates: [
      { label: "NapCatQQ Shell / Windows 安装文档", url: "https://www.napcat.wiki/guide/boot/Shell" },
      { label: "NapCatQQ Releases", url: "https://github.com/NapNeko/NapCatQQ/releases" }
    ],
    endpoints: napcatWebuiEndpoints,
    requirements: [
      { id: "process", label: "NapCat 或 QQNT 后台进程", required: true, ok: napcatProcesses.length > 0, detail: napcatProcesses.length ? napcatProcesses.slice(0, 3).map(item => `${item.name}(${item.pid})`).join(", ") : "未发现本机 NapCat/QQNT 进程。" },
      { id: "route", label: "RabiRoute NapCat WS 入口", required: true, ok: runtimes.some((runtime) => Boolean(runtime.process)), detail: runtimes.length ? "已配置 NapCat 消息端。" : "还没有路由启用 NapCat。" },
      { id: "login", label: "OneBot 登录资料", required: true, ok: napcatConnected, detail: napcatConnected ? "已读取到连接或登录资料。" : "尚未看到 WS 连接或 get_login_info 成功。" },
      { id: "webui", label: "NapCat WebUI 可访问", required: false, ok: napcatWebuiEndpoints.some((endpoint) => endpoint.healthy), detail: "用于配置 WebSocket Client、HTTP Server 和多账号实例。" },
      { id: "webui-token", label: "NapCat WebUI 登录 Token", required: true, ok: napcatWebuiToken.found, detail: napcatWebuiToken.found ? `已从 ${napcatWebuiToken.configPath} 读取到 ${napcatWebuiToken.tokenLength} 位登录密钥。` : napcatWebuiToken.message }
    ],
    warnings: [
      ...(napcatConnected ? [] : ["NapCat 要在 WebUI 中把 WebSocket Client 连到 RabiRoute 对应 WS 地址。"]),
      "多 QQ 需要多个 NapCat instance；每个实例单独配置 WS 端口、HTTP 地址、WebUI 和启动命令。"
    ]
  };
}
