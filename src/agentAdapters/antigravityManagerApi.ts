/**
 * Manager-facing Antigravity scan/status.
 *
 * Discovery only. This module reports which Antigravity conversations exist and
 * whether the host is reachable; it never carries prompt text. The single real
 * message path lives in `src/antigravityBridge.ts` via `src/antigravityRuntime.ts`.
 */

import { agentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import {
  antigravitySummariesDatabasePath,
  antigravityHostRunning,
  listAntigravitySessions,
  listAntigravityWorkspaces
} from "../antigravitySessionStore.js";
import { resolveAntigravityCliPath } from "../antigravityBridge.js";
import type {
  AgentScanProject,
  AgentScanResult,
  AgentScanSession
} from "./managerApi.js";

export type AntigravityScanQuery = {
  antigravityLimit?: number;
  antigravityOffset?: number;
  antigravityQuery?: string;
  antigravityWorkspace?: string;
};

export type AntigravityScanContext = {
  /** Overrides for tests and for hosts with a relocated data directory. */
  antigravityDatabasePath?: string;
  antigravityAppDataDir?: string;
  antigravityCliPath?: string;
  antigravityHostRunning?: () => boolean;
};

export function scanAntigravityAgentAdapter(
  ctx: AntigravityScanContext = {},
  options: AntigravityScanQuery = {}
): { agents: { antigravity: AgentScanResult }; cwdOptions: string[] } {
  const manifest = agentAdapterManifest("antigravity");
  const limit = Math.max(1, Math.min(500, Math.floor(options.antigravityLimit ?? 200)));
  const offset = Math.max(0, Math.floor(options.antigravityOffset ?? 0));
  const query = String(options.antigravityQuery || "").trim() || undefined;
  const workspace = String(options.antigravityWorkspace || "").trim() || undefined;
  const databasePath = ctx.antigravityDatabasePath ?? antigravitySummariesDatabasePath();

  const warnings: string[] = [];
  // The injected probe wins; otherwise the store's short-lived cache is used so
  // a scan does not spawn `tasklist` on every request.
  const hostRunning = ctx.antigravityHostRunning
    ? ctx.antigravityHostRunning()
    : antigravityHostRunning();

  let sessions: AgentScanSession[] = [];
  let total = 0;
  let hasMore = false;
  let projects: AgentScanProject[] = [];
  let indexReadable = true;
  try {
    const page = listAntigravitySessions({
      ...(ctx.antigravityAppDataDir ? { appDataDir: ctx.antigravityAppDataDir } : {}),
      ...(ctx.antigravityDatabasePath ? { databasePath: ctx.antigravityDatabasePath } : {}),
      limit,
      offset,
      ...(query ? { query } : {}),
      ...(workspace ? { workspace } : {})
    });
    total = page.total;
    hasMore = page.hasMore;
    sessions = page.sessions.map((session) => ({
      id: session.id,
      name: session.title,
      ...(session.workspaceUris.length ? { projectPath: session.workspaceUris[0] } : {}),
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
      // Antigravity has no separate user-named field; `title` is the only name.
      userNamed: false,
      status: session.status,
      live: hostRunning
    }));

    projects = listAntigravityWorkspaces({
      ...(ctx.antigravityAppDataDir ? { appDataDir: ctx.antigravityAppDataDir } : {}),
      ...(ctx.antigravityDatabasePath ? { databasePath: ctx.antigravityDatabasePath } : {})
    }).map((workspacePath) => ({
      label: workspacePath,
      path: workspacePath,
      exists: true
    }));
  } catch (error) {
    indexReadable = false;
    warnings.push(
      `读取 Antigravity 会话索引失败：${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (indexReadable && total === 0) {
    warnings.push("未发现 Antigravity 会话；请确认 Antigravity 桌面已启动并至少有过一次对话。");
  }
  if (!hostRunning) {
    warnings.push("Antigravity language server 未运行；投递前请先打开 Antigravity 桌面。");
  }

  const cliPath = ctx.antigravityCliPath ?? resolveAntigravityCliPath();
  const customEndpoint = Boolean(process.env.ANTIGRAVITY_LS_ADDRESS?.trim());
  warnings.push(customEndpoint
    ? "已通过 ANTIGRAVITY_LS_ADDRESS 显式指定 language server 地址；否则每次投递会按进程动态发现。"
    : "投递走官方 `agy agentapi`：language server 端口按进程动态发现，CSRF 令牌从桌面启动日志读取，均无需手工配置。");
  warnings.push("Antigravity 适配仍为实验性；宿主版本升级可能改动 agentapi 子命令契约。");

  return {
    agents: {
      antigravity: {
        type: manifest.type,
        label: manifest.label,
        maturity: manifest.maturity,
        transport: { ...manifest.transport },
        ...(manifest.host ? { host: { ...manifest.host } } : {}),
        installed: hostRunning || indexReadable,
        installCandidates: [{ label: "agy agentapi", path: cliPath }],
        auth: {
          required: false,
          loggedIn: hostRunning,
          message: hostRunning
            ? "Antigravity 桌面已在运行；投递不需要额外凭据。"
            : `未检测到 Antigravity language server。启动入口：${cliPath}`
        },
        projects,
        sessions,
        sessionPage: {
          offset,
          limit,
          returned: sessions.length,
          hasMore,
          ...(hasMore ? { nextOffset: offset + sessions.length } : {})
        },
        warnings
      }
    },
    cwdOptions: projects.map((project) => project.path)
  };
}
