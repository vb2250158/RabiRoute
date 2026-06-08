import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentAdapterType } from "./types.js";

type AgentMaturity = "verified" | "experimental" | "stub";

type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
};

type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean }>;
  warnings?: string[];
};

type GatewayDefinitionLike = {
  codexThreadName?: string;
  codexCwd?: string;
  copilotCwd?: string;
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
};

type RuntimeLike = {
  definition: GatewayDefinitionLike;
};

type CopilotSessionEntry = {
  id: string;
  name: string;
  cwd?: string;
  userNamed?: boolean;
  updatedAt?: string;
};

type SessionThreadRecord = {
  id: string;
  threadName: string;
  updatedAt: string;
};

type AstrbotSessionScan = {
  authVerified: boolean;
  authMessage?: string;
  projects: AgentScanProject[];
  sessions: AgentScanSession[];
  source: "api" | "local-db" | "none";
};

export type AstrbotLoginTestRequest = {
  url?: string;
  username?: string;
  password?: string;
};

export type MarvisOpenRequest = {
  appId?: string;
  url?: string;
};

export type AgentManagerApiContext = {
  rootDir: string;
  runtimes?: Iterable<RuntimeLike>;
  getRuntimes?: () => Iterable<RuntimeLike>;
  projects?: AgentScanProject[];
  codexSessions?: AgentScanSession[];
  threadNames?: string[];
  cwdOptions?: string[];
  copilotSessions?: CopilotSessionEntry[];
  copilotBins?: string[];
  marvisAppIds?: string[];
  sessionIndexPath: string | (() => string);
  checkHttpEndpoint?: (url: string, timeoutMs?: number) => Promise<boolean>;
  resolveWingetCopilot?: () => string | null;
};

export type ManagerApiResponse<T extends Record<string, unknown> = Record<string, unknown>> = {
  status: number;
  body: T;
};

export async function scanAgentAdapters(ctx: AgentManagerApiContext): Promise<Record<string, unknown>> {
  const runtimes = getRuntimeList(ctx);
  const sessionIndex = resolveSessionIndexPath(ctx);
  const copilotSessions = ctx.copilotSessions ?? readCopilotSessions();
  const copilotSessionNames = [...new Set(copilotSessions.map((s) => s.name))];

  const legacySessionThreads = ctx.codexSessions
    ? ctx.codexSessions.map((session) => ({
        id: session.id ?? session.name,
        threadName: session.name,
        updatedAt: session.updatedAt ?? ""
      }))
    : readLatestSessionThreads(sessionIndex);
  const legacyThreadNames = [...new Set(legacySessionThreads.map((r) => r.threadName))];
  const configThreadNames = runtimes.map((r) => r.definition.codexThreadName).filter(Boolean) as string[];
  const threadNames = ctx.threadNames ?? [...new Set([...copilotSessionNames, ...legacyThreadNames, ...configThreadNames])];

  const cwdOptions = ctx.cwdOptions ?? collectCwdOptions(ctx.rootDir, runtimes, copilotSessions);
  const copilotBins = ctx.copilotBins ?? await detectCopilotBins(ctx.resolveWingetCopilot);
  const marvisAppIds = ctx.marvisAppIds ?? detectMarvisAppIds();
  const projects = ctx.projects ?? projectOptionsFromPaths(cwdOptions);
  const codexSessions: AgentScanSession[] = ctx.codexSessions ?? legacySessionThreads.map((record) => ({
    id: record.id,
    name: record.threadName,
    updatedAt: record.updatedAt
  }));
  const copilotScanSessions: AgentScanSession[] = copilotSessions.map((session) => ({
    id: session.id,
    name: session.name,
    projectPath: session.cwd,
    updatedAt: session.updatedAt,
    userNamed: session.userNamed
  }));

  const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  const copilotLoggedIn = readCopilotLoggedIn(copilotHome);

  const configuredAstrbotUrls = runtimes.map((runtime) => runtime.definition.astrbotUrl?.trim()).filter(Boolean) as string[];
  const configuredAstrbotPasswords = runtimes.map((runtime) => runtime.definition.astrbotPassword?.trim()).filter(Boolean) as string[];
  const configuredAstrbotUsernames = runtimes.map((runtime) => runtime.definition.astrbotUsername?.trim()).filter(Boolean) as string[];
  const astrbotUrls = [...new Set([
    ...configuredAstrbotUrls,
    process.env.ASTRBOT_URL,
    "http://127.0.0.1:6185"
  ].filter(Boolean) as string[])];
  const checkEndpoint = ctx.checkHttpEndpoint ?? checkHttpEndpoint;
  const astrbotEndpoints = await Promise.all(astrbotUrls.map(async (url) => ({
    label: url.includes("127.0.0.1") || url.includes("localhost") ? "本机 AstrBot" : "AstrBot",
    url,
    healthy: await checkEndpoint(url)
  })));

  const astrbotPluginDir = path.join(os.homedir(), ".astrbot", "data", "plugins", "rabiroute_agent");
  const astrbotPluginInstalled = fs.existsSync(path.join(astrbotPluginDir, "main.py"))
    && fs.existsSync(path.join(astrbotPluginDir, "metadata.yaml"));
  const astrbotPluginSourceReady = fs.existsSync(path.join(ctx.rootDir, "scripts", "rabiroute_agent", "main.py"))
    && fs.existsSync(path.join(ctx.rootDir, "scripts", "rabiroute_agent", "metadata.yaml"));
  const astrbotPasswordPresent = Boolean(process.env.ASTRBOT_PASSWORD?.trim() || configuredAstrbotPasswords.length > 0);
  const astrbotBaseUrl = (configuredAstrbotUrls[0] || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
  const astrbotUsername = configuredAstrbotUsernames[0] || process.env.ASTRBOT_USERNAME || "";
  const astrbotPassword = configuredAstrbotPasswords[0] || process.env.ASTRBOT_PASSWORD || "";
  let astrbotSessionScan: AstrbotSessionScan = {
    authVerified: false,
    authMessage: astrbotPasswordPresent ? "已填写 AstrBot 凭据，尚未验证 Dashboard 登录。" : "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。",
    projects: [],
    sessions: [],
    source: "none"
  };
  if (astrbotPasswordPresent && astrbotEndpoints.some((endpoint) => endpoint.healthy)) {
    const login = await loginAstrbotDashboard(astrbotBaseUrl, astrbotUsername, astrbotPassword);
    if (login.token) {
      astrbotSessionScan = await scanAstrbotViaDashboardApi(astrbotBaseUrl, astrbotUsername, login.token);
    } else {
      astrbotSessionScan.authMessage = `已填写 AstrBot 凭据，但 Dashboard 登录未通过：${login.message || "未知错误"}`;
    }
  }
  if (astrbotSessionScan.sessions.length === 0 || astrbotSessionScan.projects.length === 0) {
    const localScan = await scanAstrbotLocalDb();
    astrbotSessionScan = {
      ...astrbotSessionScan,
      projects: astrbotSessionScan.projects.length ? astrbotSessionScan.projects : localScan.projects,
      sessions: astrbotSessionScan.sessions.length ? astrbotSessionScan.sessions : localScan.sessions,
      source: astrbotSessionScan.source === "api" ? "api" : localScan.source
    };
  }

  const agents: Record<AgentAdapterType, AgentScanResult> = {
    codexDesktop: {
      type: "codexDesktop",
      label: "Codex Desktop",
      maturity: "verified",
      installed: fs.existsSync(sessionIndex),
      projects,
      sessions: codexSessions,
      warnings: [
        ...(codexSessions.length === 0 ? [`未在 ${sessionIndex} 发现 Codex 会话索引。`] : []),
        "本页不会自动向现有 Codex 会话发送烟测消息；同会话重复注入需要人工确认后再测。"
      ]
    },
    codexApp: {
      type: "codexApp",
      label: "Codex App",
      maturity: "verified",
      installed: fs.existsSync(sessionIndex),
      projects,
      sessions: codexSessions,
      warnings: [
        ...(codexSessions.length === 0 ? [`未在 ${sessionIndex} 发现 Codex 会话索引。`] : []),
        "复用 Codex 会话/项目模型；真实消息注入仍以绑定线程状态为准。"
      ]
    },
    copilotCli: {
      type: "copilotCli",
      label: "Copilot CLI",
      maturity: "experimental",
      installed: copilotBins.length > 0,
      installCandidates: copilotBins.map((binPath) => ({ label: path.basename(binPath), path: binPath })),
      auth: {
        required: true,
        loggedIn: copilotLoggedIn,
        loginUrl: "https://github.com/login/device",
        message: copilotLoggedIn ? "已发现 Copilot 登录状态。" : `未在 ${copilotHome} 发现登录状态。`
      },
      projects,
      sessions: copilotScanSessions,
      warnings: [
        "尚未完成真实端到端烟测：需确认 --name 会复用同一会话，且连续两次注入不会新开线程。",
        ...(copilotScanSessions.length === 0 ? ["未发现 Copilot session-state；会话下拉需要先运行过 Copilot CLI。"] : [])
      ]
    },
    marvis: {
      type: "marvis",
      label: "Marvis",
      maturity: "stub",
      installed: marvisAppIds.length > 0,
      installCandidates: marvisAppIds.map((id) => ({ label: id })),
      warnings: [
        "当前 Marvis 适配更像打开 App/复制 prompt 的人工接力，不是可靠的线程消息注入。",
        "不能列会话、不能创建会话，也不能验证同会话重复注入；不要标为 verified。"
      ]
    },
    astrbot: {
      type: "astrbot",
      label: "AstrBot",
      maturity: "experimental",
      installed: astrbotEndpoints.some((endpoint) => endpoint.healthy),
      auth: {
        required: true,
        loggedIn: astrbotSessionScan.authVerified,
        message: astrbotSessionScan.authMessage
      },
      endpoints: astrbotEndpoints,
      projects: astrbotSessionScan.projects,
      sessions: astrbotSessionScan.sessions,
      plugins: [{
        id: "rabiroute_agent",
        name: "RabiRoute Agent 插件",
        installed: astrbotPluginInstalled,
        healthy: astrbotPluginInstalled,
        version: astrbotPluginSourceReady ? "source-ready" : undefined
      }],
      warnings: [
        ...(astrbotSessionScan.source === "local-db" ? ["已从本机 AstrBot 数据库读取项目/会话；发送前仍需 Dashboard 登录或 API Key 验证。"] : []),
        ...(astrbotSessionScan.sessions.length === 0 ? ["未读取到 AstrBot WebChat 会话；可以在 AstrBot ChatUI 创建对话后重新扫描。"] : []),
        "尚未自动执行真实消息注入烟测；同会话连续两次发送需用户确认后再测。",
        ...(astrbotPluginInstalled ? [] : [`插件未安装到 ${astrbotPluginDir}。`])
      ]
    }
  };

  return {
    agents,
    legacy: {
      threadNames,
      cwdOptions,
      copilotSessions: copilotSessions.map((s) => ({ name: s.name, cwd: s.cwd, userNamed: s.userNamed })),
      copilotBins: [...new Set(copilotBins)],
      marvisAppIds: [...new Set(marvisAppIds)]
    },
    threadNames,
    cwdOptions,
    copilotSessions: copilotSessions.map((s) => ({ name: s.name, cwd: s.cwd, userNamed: s.userNamed })),
    copilotBins: [...new Set(copilotBins)],
    marvisAppIds: [...new Set(marvisAppIds)]
  };
}

export async function testAstrbotLogin(request: AstrbotLoginTestRequest): Promise<Record<string, unknown>> {
  const baseUrl = (request.url?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
  const username = request.username?.trim() || process.env.ASTRBOT_USERNAME || "";
  const password = request.password?.trim() || process.env.ASTRBOT_PASSWORD || "";
  if (!password) {
    return { ok: false, status: 400, message: "缺少 AstrBot 密码。" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body: { status?: string; data?: { token?: string } | null; message?: string; error?: string; detail?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }

    if (!response.ok || body.status === "error" || body.error) {
      const rawMessage = body.message || body.error || body.detail || text || `HTTP ${response.status}`;
      const credentialHint = response.status === 401 || response.status === 403 || /password|credential|用户名|密码|登录|auth/i.test(rawMessage);
      return {
        ok: false,
        status: response.status,
        message: credentialHint ? `AstrBot 登录失败：账号或密码可能不正确。(${rawMessage})` : `AstrBot 登录失败：${rawMessage}`
      };
    }

    if (!body.data?.token) {
      return { ok: false, status: response.status, message: "AstrBot 登录响应里没有 token，可能 API 版本不匹配。" };
    }

    const token = body.data.token;
    const sessions = await scanAstrbotViaDashboardApi(baseUrl, username, token);
    const counts = sessions.source === "api"
      ? ` 已读取 ${sessions.projects.length} 个项目、${sessions.sessions.length} 个会话。`
      : "";
    return { ok: true, status: response.status, message: `AstrBot 登录验证成功。${counts}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message: message.includes("abort") ? "AstrBot 登录验证超时。" : `AstrBot 登录验证失败：${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function getCopilotStatus(ctx: AgentManagerApiContext): Promise<Record<string, unknown>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let installed = false;
  let binPath = ctx.resolveWingetCopilot?.() ?? "";
  if (binPath) {
    installed = true;
  } else {
    const whereCmd = process.platform === "win32" ? "where.exe" : "which";
    try {
      const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: 2000 });
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        .find((p) => !p.endsWith(".ps1"));
      if (first) {
        installed = true;
        binPath = first;
      }
    } catch {
      // not installed
    }
  }
  const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  return { installed, binPath, loggedIn: readCopilotLoggedIn(copilotHome), copilotHome };
}

export function openMarvis(_ctx: AgentManagerApiContext, request: MarvisOpenRequest): Record<string, unknown> {
  const appId = request.appId?.trim() || process.env.MARVIS_APP_ID?.trim() || "Tencent.Marvis";
  const url = request.url?.trim() || process.env.MARVIS_URL?.trim() || "https://marvis.qq.com/";
  if (process.platform === "win32") {
    spawnDetached("explorer.exe", [`shell:AppsFolder\\${appId}`]);
    return { ok: true, mode: "desktop", target: appId, message: `已尝试打开 Marvis 应用：${appId}` };
  }

  openUrlWithDefaultApp(url);
  return { ok: true, mode: "url", target: url, message: `已尝试打开 Marvis 页面：${url}` };
}

export async function deployAstrbotAdapter(ctx: AgentManagerApiContext): Promise<ManagerApiResponse> {
  try {
    const scriptPath = path.resolve(ctx.rootDir, "scripts", "deploy-astrbot-adapter.cmd");
    if (!fs.existsSync(scriptPath)) {
      return { status: 404, body: { ok: false, error: `部署脚本未找到: ${scriptPath}` } };
    }
    return await new Promise<ManagerApiResponse>((resolve) => {
      const child = spawn(scriptPath, [], {
        cwd: ctx.rootDir,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve({ status: 200, body: { ok: true, message: "AstrBot Adapter 部署成功", stdout: stdout.slice(0, 2000) } });
        } else {
          resolve({ status: 500, body: { ok: false, error: `部署失败 (exit ${code})`, stderr: stderr.slice(0, 2000) } });
        }
      });
      child.on("error", (error) => {
        resolve({ status: 500, body: { ok: false, error: String(error) } });
      });
    });
  } catch (err: unknown) {
    return { status: 500, body: { ok: false, error: String(err) } };
  }
}

function getRuntimeList(ctx: AgentManagerApiContext): RuntimeLike[] {
  const source = ctx.getRuntimes ? ctx.getRuntimes() : ctx.runtimes;
  return source ? [...source] : [];
}

function resolveSessionIndexPath(ctx: AgentManagerApiContext): string {
  return typeof ctx.sessionIndexPath === "function" ? ctx.sessionIndexPath() : ctx.sessionIndexPath;
}

function readCopilotSessions(): CopilotSessionEntry[] {
  const copilotSessionStateDir = path.join(os.homedir(), ".copilot", "session-state");
  const sessions: CopilotSessionEntry[] = [];
  try {
    for (const entry of fs.readdirSync(copilotSessionStateDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const yamlPath = path.join(copilotSessionStateDir, entry.name, "workspace.yaml");
      if (!fs.existsSync(yamlPath)) continue;
      try {
        const yamlContent = fs.readFileSync(yamlPath, "utf8");
        const idMatch = yamlContent.match(/^id:\s*(.+)$/m);
        const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
        const cwdMatch = yamlContent.match(/^cwd:\s*(.+)$/m);
        const userNamedMatch = yamlContent.match(/^user_named:\s*(.+)$/m);
        const updatedMatch = yamlContent.match(/^updated_at:\s*(.+)$/m);
        if (idMatch && nameMatch) {
          sessions.push({
            id: idMatch[1].trim(),
            name: nameMatch[1].trim(),
            cwd: cwdMatch?.[1].trim(),
            userNamed: userNamedMatch?.[1].trim() === "true",
            updatedAt: updatedMatch?.[1].trim()
          });
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // dir not found
  }
  return sessions;
}

function collectCwdOptions(rootDir: string, runtimes: RuntimeLike[], copilotSessions: CopilotSessionEntry[]): string[] {
  const copilotCwds = [...new Set(copilotSessions.map((s) => s.cwd).filter(Boolean) as string[])].filter(fs.existsSync);
  const cwdSet = new Set<string>(copilotCwds);
  for (const rt of runtimes) {
    if (rt.definition.codexCwd && fs.existsSync(rt.definition.codexCwd)) cwdSet.add(rt.definition.codexCwd);
    if (rt.definition.copilotCwd && fs.existsSync(rt.definition.copilotCwd)) cwdSet.add(rt.definition.copilotCwd);
  }
  try {
    const parentDir = path.dirname(rootDir);
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) cwdSet.add(path.join(parentDir, entry.name));
    }
  } catch {
    // skip
  }
  return [...cwdSet];
}

async function detectCopilotBins(resolveWingetCopilot?: () => string | null): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const whereCmd = process.platform === "win32" ? "where.exe" : "which";
  const copilotBins: string[] = [];
  try {
    const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: 2000 });
    copilotBins.push(...stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  } catch {
    // not found
  }
  const wingetBin = resolveWingetCopilot?.();
  if (wingetBin && fs.existsSync(wingetBin)) {
    copilotBins.unshift(wingetBin);
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const userProfile = process.env.USERPROFILE ?? "";
    const wingetBase = path.join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const entry of fs.readdirSync(wingetBase)) {
        if (entry.startsWith("GitHub.Copilot")) {
          const exe = path.join(wingetBase, entry, "copilot.exe");
          if (fs.existsSync(exe)) copilotBins.unshift(exe);
        }
      }
    } catch {
      // skip
    }
    for (const root of [
      path.join(localAppData, "Programs", "Microsoft VS Code"),
      path.join(localAppData, "Programs", "Microsoft VS Code Insiders"),
      path.join(userProfile, ".vscode", "extensions")
    ]) {
      try {
        const extDir = path.join(root, "resources", "app", "extensions");
        if (!fs.existsSync(extDir)) continue;
        for (const entry of fs.readdirSync(extDir)) {
          if (!entry.startsWith("github.copilot-chat")) continue;
          for (const binName of ["copilot.exe", "copilot", "cli/copilot.exe"]) {
            const p = path.join(extDir, entry, "dist", binName);
            if (fs.existsSync(p)) copilotBins.push(p);
          }
        }
      } catch {
        // skip
      }
    }
    try {
      const vsDir = path.join(localAppData, "Microsoft", "VisualStudio");
      if (fs.existsSync(vsDir)) {
        for (const vsVer of fs.readdirSync(vsDir, { withFileTypes: true })) {
          if (!vsVer.isDirectory()) continue;
          const extRoot = path.join(vsDir, vsVer.name, "Extensions");
          if (!fs.existsSync(extRoot)) continue;
          for (const extId of fs.readdirSync(extRoot, { withFileTypes: true })) {
            if (!extId.isDirectory()) continue;
            const distDir = path.join(extRoot, extId.name, "service", "dist");
            if (!fs.existsSync(distDir)) continue;
            for (const f of fs.readdirSync(distDir)) {
              if (f.startsWith("copilot-agent") && f.endsWith(".exe")) {
                copilotBins.push(path.join(distDir, f));
              }
            }
          }
        }
      }
    } catch {
      // skip
    }
  }
  return copilotBins;
}

function detectMarvisAppIds(): string[] {
  const marvisAppIds = ["Tencent.Marvis"];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    for (const base of [appData, localAppData]) {
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().includes("marvis")) {
            marvisAppIds.push(entry.name);
          }
        }
      } catch {
        // skip
      }
    }
  }
  return marvisAppIds;
}

function readCopilotLoggedIn(copilotHome: string): boolean {
  try {
    const configPath = path.join(copilotHome, "config.json");
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/[^\n]*\n/gm, "");
      const cfg = JSON.parse(raw) as { loggedInUsers?: unknown[] };
      return Array.isArray(cfg.loggedInUsers) && cfg.loggedInUsers.length > 0;
    }
  } catch {
    // ignore
  }
  return false;
}

function readLatestSessionThreads(indexPath: string): SessionThreadRecord[] {
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const latestById = new Map<string, SessionThreadRecord>();
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof parsed.id !== "string" || typeof parsed.thread_name !== "string" || typeof parsed.updated_at !== "string") {
        continue;
      }
      const record = {
        id: parsed.id,
        threadName: parsed.thread_name,
        updatedAt: parsed.updated_at
      };
      const existing = latestById.get(record.id);
      if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
        latestById.set(record.id, record);
      }
    } catch {
      // Ignore malformed JSONL lines.
    }
  }

  return [...latestById.values()];
}

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectOptionsFromPaths(paths: string[]): AgentScanProject[] {
  const byNormalized = new Map<string, AgentScanProject>();
  for (const item of paths) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const normalized = normalizeComparablePath(trimmed);
    if (!normalized || byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, {
      label: path.basename(trimmed) || trimmed,
      path: trimmed,
      exists: fs.existsSync(trimmed)
    });
  }
  return [...byNormalized.values()];
}

async function checkHttpEndpoint(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function loginAstrbotDashboard(baseUrl: string, username: string, password: string): Promise<{ token?: string; message?: string }> {
  if (!password) {
    return { message: "缺少 AstrBot 密码。" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4200);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body: { status?: string; data?: { token?: string } | null; message?: string; error?: string; detail?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }
    if (!response.ok || body.status === "error" || body.error) {
      return { message: body.message || body.error || body.detail || `HTTP ${response.status}` };
    }
    return { token: body.data?.token, message: body.data?.token ? undefined : "登录响应缺少 token。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message.includes("abort") ? "登录请求超时。" : message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAstrbotJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const body = await response.json() as { status?: string; data?: T };
    if (body.status === "error") return null;
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function scanAstrbotViaDashboardApi(baseUrl: string, _username: string, token: string): Promise<AstrbotSessionScan> {
  type ProjectApiItem = { project_id?: string; title?: string; emoji?: string; updated_at?: string };
  type SessionApiItem = { session_id?: string; platform_id?: string; display_name?: string; updated_at?: string };
  const projectsRaw = await fetchAstrbotJson<ProjectApiItem[]>(`${baseUrl}/api/chatui_project/list`, token);
  const sessionsRaw = await fetchAstrbotJson<SessionApiItem[]>(`${baseUrl}/api/chat/sessions?platform_id=webchat`, token);
  if (!projectsRaw && !sessionsRaw) {
    return { authVerified: true, projects: [], sessions: [], source: "none", authMessage: "已登录，但未读取到项目/会话 API。" };
  }
  const projects: AgentScanProject[] = (projectsRaw ?? []).map((project) => {
    const label = [project.emoji, project.title].filter(Boolean).join(" ") || project.project_id || "未命名项目";
    const pathValue = project.title || label;
    return {
      id: project.project_id,
      label,
      path: pathValue,
      exists: pathValue ? fs.existsSync(pathValue) : false
    };
  });
  const sessions: AgentScanSession[] = (sessionsRaw ?? []).map((session) => ({
    id: session.session_id,
    name: session.display_name || session.session_id || "未命名会话",
    updatedAt: session.updated_at
  }));
  for (const project of projectsRaw ?? []) {
    if (!project.project_id) continue;
    const projectSessions = await fetchAstrbotJson<SessionApiItem[]>(`${baseUrl}/api/chatui_project/get_sessions?project_id=${encodeURIComponent(project.project_id)}`, token);
    for (const session of projectSessions ?? []) {
      const existing = sessions.find((item) => item.id === session.session_id);
      if (existing) {
        existing.projectId = project.project_id;
        existing.projectPath = project.title;
      } else {
        sessions.push({
          id: session.session_id,
          name: session.display_name || session.session_id || "未命名会话",
          projectId: project.project_id,
          projectPath: project.title,
          updatedAt: session.updated_at
        });
      }
    }
  }
  return { authVerified: true, projects, sessions, source: "api", authMessage: `已通过 Dashboard API 读取 ${projects.length} 个项目、${sessions.length} 个会话。` };
}

async function scanAstrbotLocalDb(): Promise<Pick<AstrbotSessionScan, "projects" | "sessions" | "source">> {
  const dbPath = path.join(os.homedir(), ".astrbot", "data", "data_v4.db");
  if (!fs.existsSync(dbPath)) {
    return { projects: [], sessions: [], source: "none" };
  }
  const pyCandidates = [
    "py",
    "python",
    path.join(process.env.LOCALAPPDATA ?? "", "AstrBot", "backend", "python", "python.exe")
  ].filter(Boolean);
  const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
projects = [dict(r) for r in con.execute("select project_id, title, emoji, updated_at from chatui_projects order by updated_at desc limit 100")]
sessions = [dict(r) for r in con.execute("""select s.session_id, s.display_name, s.updated_at, p.project_id, p.title as project_title
from platform_sessions s
left join session_project_relations rel on rel.session_id=s.session_id
left join chatui_projects p on p.project_id=rel.project_id
where s.platform_id='webchat'
order by s.updated_at desc limit 200""")]
print(json.dumps({"projects": projects, "sessions": sessions}, ensure_ascii=False))
con.close()
`.trim();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  for (const py of pyCandidates) {
    try {
      const args = path.basename(py).toLowerCase() === "py"
        ? ["-3", "-c", script, dbPath]
        : ["-c", script, dbPath];
      const { stdout } = await execFileAsync(py, args, {
        timeout: 3000,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" }
      });
      const parsed = JSON.parse(stdout) as {
        projects?: Array<{ project_id?: string; title?: string; emoji?: string; updated_at?: string }>;
        sessions?: Array<{ session_id?: string; display_name?: string; updated_at?: string; project_id?: string; project_title?: string }>;
      };
      const projects: AgentScanProject[] = (parsed.projects ?? []).map((project) => {
        const label = [project.emoji, project.title].filter(Boolean).join(" ") || project.project_id || "未命名项目";
        const pathValue = project.title || label;
        return {
          id: project.project_id,
          label,
          path: pathValue,
          exists: pathValue ? fs.existsSync(pathValue) : false
        };
      });
      const sessions: AgentScanSession[] = (parsed.sessions ?? []).map((session) => ({
        id: session.session_id,
        name: session.display_name || session.session_id || "未命名会话",
        projectId: session.project_id,
        projectPath: session.project_title,
        updatedAt: session.updated_at
      }));
      return { projects, sessions, source: "local-db" };
    } catch {
      // try next interpreter
    }
  }
  return { projects: [], sessions: [], source: "none" };
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function openUrlWithDefaultApp(url: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }
  spawnDetached("xdg-open", [url]);
}
