/**
 * Manager-facing WorkBuddy scan/status.
 *
 * Discovery only: RabiRoute reads the published session descriptors and the
 * desktop task database. Delivery is intentionally absent — the gateway
 * credential acquisition path and the desktop-visibility contract are still
 * open, so no code here may carry real prompt text.
 *
 * See docs/workbuddy-agent-adapter-plan.md.
 */

import { agentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import {
  listWorkbuddySessionDescriptors,
  listWorkbuddyTasks,
  listWorkbuddyWorkspaces,
  normalizeWorkbuddyWorkspace,
  readWorkbuddyTaskRows,
  workbuddyProjectId,
  workbuddySessionsDir
} from "../workbuddySessionStore.js";
import type {
  AgentManagerApiContext,
  AgentScanOptions,
  AgentScanProject,
  AgentScanResult,
  AgentScanSession
} from "./managerApi.js";

export async function scanWorkbuddyAgentAdapter(
  ctx: AgentManagerApiContext,
  options: Pick<
    AgentScanOptions,
    "workbuddyLimit" | "workbuddyOffset" | "workbuddyQuery" | "workbuddyWorkspace"
  > = {}
): Promise<{ agents: { workbuddy: AgentScanResult }; cwdOptions: string[] }> {
  const manifest = agentAdapterManifest("workbuddy");
  const limit = Math.max(1, Math.min(500, Math.floor(options.workbuddyLimit ?? 200)));
  const offset = Math.max(0, Math.floor(options.workbuddyOffset ?? 0));
  const query = String(options.workbuddyQuery || "").trim() || undefined;
  const workspace = String(options.workbuddyWorkspace || "").trim() || undefined;
  const sessionsDir = ctx.workbuddySessionsDir ?? workbuddySessionsDir();
  const databasePath = ctx.workbuddyDatabasePath;

  let descriptors: ReturnType<typeof listWorkbuddySessionDescriptors> = [];
  let rows: ReturnType<typeof readWorkbuddyTaskRows> = [];
  const warnings: string[] = [];
  try {
    descriptors = listWorkbuddySessionDescriptors({ sessionsDir });
  } catch (error) {
    warnings.push(`读取 WorkBuddy 会话进程描述失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    rows = readWorkbuddyTaskRows(databasePath);
  } catch (error) {
    warnings.push(`读取 WorkBuddy 任务库失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (rows.length === 0) {
    warnings.push("未发现 WorkBuddy 任务；请确认 WorkBuddy 桌面已启动并至少有过一次对话。");
  }

  const allTasks = listWorkbuddyTasks({ databasePath, descriptors, includeArchived: false });
  const filtered = allTasks
    .filter(task => !workspace || normalizeWorkbuddyWorkspace(task.workspace) === normalizeWorkbuddyWorkspace(workspace))
    .filter(task => !query
      || task.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      || task.autoTitle.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const hasMore = filtered.length > limit;
  const page = filtered.slice(offset, offset + limit);
  const sessions: AgentScanSession[] = page.map(task => ({
    id: task.id,
    name: task.name,
    projectPath: task.workspace,
    ...(workbuddyProjectId(task.workspace) ? { projectId: workbuddyProjectId(task.workspace) } : {}),
    ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}),
    userNamed: task.userNamed
  }));

  const checkEndpoint = ctx.checkHttpEndpoint;
  const liveDescriptors = descriptors.filter(descriptor => descriptor.processAlive && descriptor.endpoint);
  const endpoints = await Promise.all(liveDescriptors.map(async (descriptor) => ({
    label: `WorkBuddy 会话进程 ${descriptor.pid}（${descriptor.kind}）`,
    url: descriptor.endpoint as string,
    healthy: descriptor.stale
      ? false
      : checkEndpoint
        ? await checkEndpoint(descriptor.endpoint as string, 1_500).catch(() => false)
        : true
  })));

  const staleCount = descriptors.filter(descriptor => descriptor.stale || !descriptor.processAlive).length;
  if (staleCount > 0) {
    warnings.push(`有 ${staleCount} 个会话进程描述已过期或进程已退出；这些任务当前不可投递。`);
  }
  const liveWithoutEndpoint = descriptors.filter(descriptor => descriptor.processAlive && !descriptor.endpoint).length;
  if (liveWithoutEndpoint > 0) {
    warnings.push(`有 ${liveWithoutEndpoint} 个会话进程未发布本地网关地址，无法作为投递目标。`);
  }
  warnings.push(
    "WorkBuddy 会话网关需要桌面注入的网关密码；RabiRoute 作为独立进程无法读取该凭据，凭据获取方式尚未验收。",
    "真实投递尚未实现：尚未证明消息会出现在用户已有任务的对话区并由同一 owner 执行，因此等级保持 experimental。"
  );

  const workspaces = listWorkbuddyWorkspaces(databasePath);
  const projects: AgentScanProject[] = workspaces.map(cwd => ({
    label: workbuddyProjectId(cwd) || cwd,
    path: cwd,
    exists: true
  }));

  return {
    agents: {
      workbuddy: {
        type: manifest.type,
        label: manifest.label,
        maturity: manifest.maturity,
        transport: { ...manifest.transport },
        ...(manifest.host ? { host: { ...manifest.host } } : {}),
        installed: rows.length > 0 || descriptors.length > 0,
        auth: {
          required: true,
          message: "会话本地网关切需要 WorkBuddy 桌面持有的网关密码；RabiRoute 不能从另一进程读取该环境变量，需按方案确定一次性录入方式。"
        },
        endpoints,
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
    cwdOptions: projects.map(project => project.path)
  };
}
