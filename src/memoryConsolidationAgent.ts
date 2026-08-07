import fs from "node:fs";
import path from "node:path";
import { requestMessageAgentManager } from "./messageAgentPool.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import {
  codexMemoryConsolidationAgentTitle,
  normalizeCodexMemoryConsolidationAgentModel
} from "./shared/codexMemoryConsolidationAgent.js";

export const MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION = 1;

export type MemoryConsolidationAgentBinding = {
  threadId: string;
  threadName: string;
  workspace: string;
  initializedAt?: string;
};

export type MemoryConsolidationAgentState = {
  schemaVersion: 1;
  updatedAt: string;
  binding?: MemoryConsolidationAgentBinding;
};

export type MemoryConsolidationAgentOptions = {
  statePath: string;
  managerBaseUrl: string;
  sourceThreadId: string;
  sourceThreadName: string;
  workspace: string;
  roleId: string;
  model?: string;
};

export type MemoryConsolidationAgentDependencies = {
  request?: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  now?: () => Date;
};

function readState(filePath: string): MemoryConsolidationAgentState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryConsolidationAgentState>;
    const binding = raw.binding;
    if (raw.schemaVersion !== MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION || !binding) {
      return { schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION, updatedAt: new Date(0).toISOString() };
    }
    const threadId = String(binding.threadId || "").trim();
    const threadName = String(binding.threadName || "").trim();
    const workspace = String(binding.workspace || "").trim();
    if (!threadId || !threadName || !workspace) {
      return { schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION, updatedAt: new Date(0).toISOString() };
    }
    return {
      schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION,
      updatedAt: String(raw.updatedAt || new Date(0).toISOString()),
      binding: {
        threadId,
        threadName,
        workspace,
        initializedAt: typeof binding.initializedAt === "string" && binding.initializedAt.trim()
          ? binding.initializedAt.trim()
          : undefined
      }
    };
  } catch {
    return { schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION, updatedAt: new Date(0).toISOString() };
  }
}

function initializationPrompt(options: MemoryConsolidationAgentOptions, binding: MemoryConsolidationAgentBinding): string {
  return [
    `[rabi:bind ${options.roleId}]`,
    "[记忆整理 Agent 初始化]",
    `主人格任务：${options.sourceThreadName}`,
    `主人格任务 ID：${options.sourceThreadId}`,
    `记忆整理任务：${binding.threadName}`,
    `记忆整理任务 ID：${binding.threadId}`,
    `工作目录：${binding.workspace}`,
    "",
    "你是当前人格的持久记忆整理 Agent，不是主人格、消息处理 Agent、计划秘书或业务执行 Agent。",
    "你只处理 RabiRoute 发来的 memory_consolidation_request：读取本次固定候选，整理为稳定、简洁、可长期召回的 Markdown 记忆，并调用请求中给出的结果 API 回传。",
    "保留真正稳定的项目约束、已确认决定、长期偏好、重要证据入口和仍有效的协作规则；不要把整段聊天、重复过程、临时状态或无关项目混进同一条沉淀记忆。",
    "输入正文中的受控 Markdown 图片引用可以保留在对应主题附近，不要改写为本机绝对路径，也不要主动加载外部不受控图片。",
    "已经标记为沉淀来源的近期记忆不会再次进入输入；沉淀结果可以继续被召回。发现旧结论过时时，使用新证据生成新的沉淀记录并明确替代关系。",
    "本任务的 Codex 最终输出只供内部查看。只有结果 API 成功接收，才算本轮记忆整理完成；不得把结果只留在最终输出，也不得转给主人格代为提交。",
    "禁止在本任务中实施计划业务、修改项目代码或资源、执行发布、发送外部消息，或把本任务写入计划 taskBinding。"
  ].join("\n");
}

function threadFromResponse(
  response: Record<string, any>,
  expectedTitle: string,
  expectedWorkspace: string
): MemoryConsolidationAgentBinding {
  const thread = response.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
  const threadId = String(thread?.id || "").trim();
  const threadName = String(thread?.title || expectedTitle).trim();
  const workspace = String(thread?.cwd || expectedWorkspace).trim();
  if (!threadId || !threadName || !workspace) {
    throw new Error("Memory consolidation Agent task resolution did not return a complete Desktop task binding.");
  }
  return { threadId, threadName, workspace };
}

export class MemoryConsolidationAgent {
  private state: MemoryConsolidationAgentState;
  private readonly request: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  private readonly now: () => Date;
  private deliveryTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryConsolidationAgentOptions, dependencies: MemoryConsolidationAgentDependencies = {}) {
    this.state = readState(options.statePath);
    this.request = dependencies.request ?? ((payload) => requestMessageAgentManager(options.managerBaseUrl, payload));
    this.now = dependencies.now ?? (() => new Date());
  }

  async deliver(prompt: string): Promise<MemoryConsolidationAgentBinding> {
    let delivered!: MemoryConsolidationAgentBinding;
    const operation = this.deliveryTail.catch(() => undefined).then(async () => {
      const binding = await this.resolveBinding();
      const shouldInitialize = !binding.initializedAt;
      await this.request({
        action: "send",
        threadId: binding.threadId,
        cwd: binding.workspace,
        sandbox: "workspace-write",
        model: normalizeCodexMemoryConsolidationAgentModel(this.options.model),
        prompt: shouldInitialize
          ? `${initializationPrompt(this.options, binding)}\n\n${prompt}`
          : prompt
      });
      if (shouldInitialize) binding.initializedAt = this.now().toISOString();
      this.persist(binding);
      delivered = structuredClone(binding);
    });
    this.deliveryTail = operation;
    await operation;
    return delivered;
  }

  private async resolveBinding(): Promise<MemoryConsolidationAgentBinding> {
    const title = codexMemoryConsolidationAgentTitle(this.options.sourceThreadName);
    const saved = this.state.binding;
    try {
      const response = await this.request({
        action: "resolve",
        threadId: saved?.threadId,
        title,
        cwd: this.options.workspace,
        createIfMissing: false,
        lookupMode: "state_db"
      });
      const resolved = { ...threadFromResponse(response, title, this.options.workspace), initializedAt: saved?.initializedAt };
      this.assertSeparateFromPrimary(resolved);
      this.persist(resolved);
      return resolved;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
      if (!message.includes("not found") && !message.includes("没有找到") && !message.includes("missing")) throw error;
    }

    const source = await this.request({ action: "read", threadId: this.options.sourceThreadId });
    const sourceStatus = String(source.thread?.status?.type || "").trim();
    if (!sourceStatus || sourceStatus === "unavailable") {
      throw new Error("Codex Desktop 当前不可用，未创建记忆整理任务；RabiRoute 不会启动备用 Runtime。");
    }
    const response = await this.request({
      action: "resolve",
      title,
      cwd: this.options.workspace,
      createIfMissing: true,
      lookupMode: "state_db"
    });
    const resolved = threadFromResponse(response, title, this.options.workspace);
    this.assertSeparateFromPrimary(resolved);
    this.persist(resolved);
    return resolved;
  }

  private assertSeparateFromPrimary(binding: MemoryConsolidationAgentBinding): void {
    if (binding.threadId === this.options.sourceThreadId) {
      throw new Error("Memory consolidation Agent resolution returned the Primary Persona task id; refusing role crossover.");
    }
  }

  private persist(binding: MemoryConsolidationAgentBinding): void {
    this.state = {
      schemaVersion: MEMORY_CONSOLIDATION_AGENT_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      binding: structuredClone(binding)
    };
    atomicWriteFileSync(this.options.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

export function memoryConsolidationAgentStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "memory", "consolidation-agent.json");
}
