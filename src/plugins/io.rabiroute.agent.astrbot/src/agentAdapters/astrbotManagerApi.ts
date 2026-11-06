import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {getTimeoutMs} from '@rabiroute/host-api/shared/timeoutSettings';
import type {AgentManagerApiContext,AgentScanOptions,AgentScanResult,AgentScanSession,AgentSessionPage,AgentScanProject,AgentScanPerformanceOperation,CopilotSessionEntry,AstrbotSessionScan,AstrbotLoginTestRequest,MarvisOpenRequest} from '@rabiroute/host-api/agentAdapters/managerTypes';
import {agentScanManifestFields,getRuntimeList,projectOptionsFromPaths,normalizeComparablePath,checkHttpEndpoint,collectAgentCwdOptions} from '@rabiroute/host-api/agentAdapters/managerScanShared';
export async function testAstrbotLogin(
  request: AstrbotLoginTestRequest
): Promise<Record<string, unknown> & { ok: boolean }> {
  const baseUrl = (request.url?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
  const username = request.username?.trim() || process.env.ASTRBOT_USERNAME || "";
  const password = request.password?.trim() || process.env.ASTRBOT_PASSWORD || "";
  if (!password) {
    return { ok: false, status: 400, message: "缺少 AstrBot 密码。" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs("deadline.agentAdapters.managerApi.testAstrbotLogin", 5000));
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
export async function loginAstrbotDashboard(baseUrl: string, username: string, password: string): Promise<{ token?: string; message?: string }> {
  if (!password) {
    return { message: "缺少 AstrBot 密码。" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs("deadline.agentAdapters.managerApi.loginAstrbotDashboard", 4200));
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
export async function fetchAstrbotJson<T>(url: string, token: string): Promise<T | null> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    if (response.status === 404) return null; // Older owners may omit an optional catalog API.
    throw Object.assign(new Error(`AstrBot Dashboard catalog request failed (HTTP ${response.status}).`), { statusCode: response.status });
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("AstrBot Dashboard returned invalid catalog JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("AstrBot Dashboard returned an invalid catalog response.");
  const envelope = body as { status?: string; data?: T };
  if (envelope.status === "error") throw new Error("AstrBot Dashboard rejected the catalog request.");
  if (!Object.prototype.hasOwnProperty.call(envelope, "data") || envelope.data === null) throw new Error("AstrBot Dashboard returned an invalid catalog payload.");
  return envelope.data as T;
}

export async function scanAstrbotViaDashboardApi(baseUrl: string, _username: string, token: string): Promise<AstrbotSessionScan> {
  const projectsRaw = await fetchAstrbotJson<unknown>(`${baseUrl}/api/chatui_project/list`, token);
  const sessionsRaw = await fetchAstrbotJson<unknown>(`${baseUrl}/api/chat/sessions?platform_id=webchat`, token);
  if (projectsRaw === null && sessionsRaw === null) {
    return { authVerified: true, projects: [], sessions: [], source: "none", authMessage: "已登录，但未读取到项目/会话 API。" };
  }
  const warnings: string[] = [];
  const records = (value: unknown, source: string): Record<string, unknown>[] => {
    if (value === null) { warnings.push(`AstrBot ${source} API is unavailable.`); return []; }
    if (!Array.isArray(value)) throw new Error("AstrBot Dashboard returned an invalid catalog array.");
    return value.flatMap((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) return [item as Record<string, unknown>];
      warnings.push(`AstrBot ${source}[${index}] is invalid and was skipped.`);
      return [];
    });
  };
  const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
  const projectRows = records(projectsRaw, "projects").flatMap(project => {
    if (!text(project.project_id)) { warnings.push("AstrBot project has no valid native ID and was skipped."); return []; }
    if (project.title !== undefined && typeof project.title !== "string" || project.emoji !== undefined && typeof project.emoji !== "string") {
      warnings.push("AstrBot project display metadata is invalid; its native ID was retained.");
    }
    return [{ ...project, project_id: String(project.project_id), title: text(project.title), emoji: text(project.emoji) }];
  });
  const projects: AgentScanProject[] = projectRows.map(project => {
    const label = [text(project.emoji), text(project.title)].filter(Boolean).join(" ") || String(project.project_id);
    const pathValue = text(project.title) || label;
    return { id: String(project.project_id), label, path: pathValue, exists: fs.existsSync(pathValue) };
  });
  const normalizeSession = (session: Record<string, unknown>): AgentScanSession | undefined => {
    const id = text(session.session_id);
    if (!id) { warnings.push("AstrBot session has no valid native ID and was skipped."); return undefined; }
    if (session.display_name !== undefined && typeof session.display_name !== "string") warnings.push("AstrBot session display name is invalid; its native ID was retained.");
    return { id, name: text(session.display_name) || id, ...(text(session.updated_at) ? { updatedAt: text(session.updated_at) } : {}) };
  };
  const sessions: AgentScanSession[] = records(sessionsRaw, "sessions").flatMap(session => {
    const normalized = normalizeSession(session);
    return normalized ? [normalized] : [];
  });
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const project of projectRows) {
    const projectId = String(project.project_id);
    let projectSessions: Record<string, unknown>[];
    try {
      const raw = await fetchAstrbotJson<unknown>(`${baseUrl}/api/chatui_project/get_sessions?project_id=${encodeURIComponent(projectId)}`, token);
      projectSessions = records(raw, "projectSessions");
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 401 || status === 403) throw error;
      warnings.push("AstrBot project session associations are unavailable; the original sessions were retained.");
      continue;
    }
    for (const session of projectSessions) {
      const normalized = normalizeSession(session);
      if (!normalized) continue;
      const existing = byId.get(normalized.id);
      if (existing) { existing.projectId = projectId; existing.projectPath = text(project.title); }
      else {
        const associated = { ...normalized, projectId, ...(text(project.title) ? { projectPath: text(project.title) } : {}) };
        sessions.push(associated); byId.set(associated.id, associated);
      }
    }
  }
  return { authVerified: true, projects, sessions, source: "api", warnings,
    authMessage: `已通过 Dashboard API 读取 ${projects.length} 个项目、${sessions.length} 个会话。` };
}
export async function scanAstrbotLocalDb(): Promise<Pick<AstrbotSessionScan, "projects" | "sessions" | "source">> {
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
        timeout: getTimeoutMs("backend.agentAdapters.managerApi.scanAstrbotLocalDb.execFileAsync.timeout", 3000),
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
export async function scanAstrbotAgentAdapter(ctx:AgentManagerApiContext,options:AgentScanOptions={}) {const checkEndpoint=ctx.checkHttpEndpoint??checkHttpEndpoint;
const runtimes = getRuntimeList(ctx);
const configuredAstrbotUrls = runtimes.map((runtime) => runtime.definition.astrbotUrl?.trim()).filter(Boolean) as string[];
const configuredAstrbotPasswords = runtimes.map((runtime) => runtime.definition.astrbotPassword?.trim()).filter(Boolean) as string[];
const configuredAstrbotUsernames = runtimes.map((runtime) => runtime.definition.astrbotUsername?.trim()).filter(Boolean) as string[];
const astrbotUrls = [...new Set([
    ...configuredAstrbotUrls,
    process.env.ASTRBOT_URL,
    "http://127.0.0.1:6185"
  ].filter(Boolean) as string[])];
const astrbotEndpoints = await Promise.all(astrbotUrls.map(async (url) => ({
    label: url.includes("127.0.0.1") || url.includes("localhost") ? "本机 AstrBot" : "AstrBot",
    url,
    healthy: await checkEndpoint(url)
  })));
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
return {agents:{astrbot:{
      ...agentScanManifestFields("astrbot",ctx.manifest),
      installed: astrbotEndpoints.some((endpoint) => endpoint.healthy),
      auth: {
        required: true,
        loggedIn: astrbotSessionScan.authVerified,
        message: astrbotSessionScan.authMessage
      },
      endpoints: astrbotEndpoints,
      projects: astrbotSessionScan.projects,
      sessions: astrbotSessionScan.sessions,
      warnings: [
        ...(astrbotSessionScan.warnings ?? []),
        ...(astrbotSessionScan.source === "local-db" ? ["已从本机 AstrBot 数据库读取项目/会话；发送前仍需 Dashboard 登录或 API Key 验证。"] : []),
        ...(astrbotSessionScan.sessions.length === 0 ? ["未读取到 AstrBot WebChat 会话；可以在 AstrBot ChatUI 创建对话后重新扫描。"] : []),
        "尚未自动执行真实消息注入烟测；同会话连续两次发送需用户确认后再测。",
      ]
    }},cwdOptions:[]};
}
