export type AgentCapabilityHintContext = {
  managerPort?: string;
  roleId: string;
};

const VOICE_IDENTITY_INTENT_PATTERN = /声纹|谁(?:在)?说的|说话人|哪些.{0,8}(?:是我|用户).{0,8}说|(?:用户|我).{0,8}说的.{0,8}(?:别人|其他人)|(?:别人|其他人).{0,8}说的|区分.{0,12}(?:用户|我|别人|其他人).{0,8}说|(?:一天|全天).{0,8}录音|voiceprint|speaker[\s_-]*identity/i;
const PLAN_ASSISTANT_INTENT_PATTERN = /计划|秘书|委派|委托|派发|分派|交给.{0,12}(?:处理|执行)|\b(?:plan|delegate|delegation|secretary)\b/i;
const REMOTE_AGENT_INTENT_PATTERN = /远端|远程.{0,12}(?:执行|任务|运行|构建|打包|设备)|(?:另一台|其他|其它)电脑.{0,12}(?:执行|运行|构建|打包)|\bremote[\s_-]*(?:agent|task|device|exec|build)\b/i;

// These gates select documentation only; they never grant permission or dispatch work.
export function needsPlanAssistantHint(text: string, routeKind: string): boolean {
  return routeKind === "plan_feedback" || PLAN_ASSISTANT_INTENT_PATTERN.test(text);
}

export function needsRemoteAgentHint(text: string): boolean {
  return REMOTE_AGENT_INTENT_PATTERN.test(text);
}

export function remoteComputerCapabilityHint(text: string, context: AgentCapabilityHintContext): string[] | null {
  if (!REMOTE_AGENT_INTENT_PATTERN.test(text) && !/\b(?:cmd|powershell)\b|终端|文件互传|查询窗口/i.test(text)) return null;
  const base = managerBaseUrl(context);
  return [
    "集群由主控 RabiPC 统一拥有人格、计划、记忆、Skill 与流程；远端客户端只提供电脑能力及关联 Agent 的执行入口。",
    `- 发现电脑：GET ${base}/api/lan-agent/instances；先核对实例名称和 instanceId。`,
    `- 读取调用合同：GET ${base}/api/lan-agent/capabilities。`,
    `- 终端列表：GET ${base}/api/lan-agent/instances/<instanceId>/terminals。`,
    `- 终端操作：POST ${base}/api/lan-agent/instances/<instanceId>/terminals；action=open|list|get|input|resize|close。`,
    "open 携带稳定 terminalId 和 shell=cmd|powershell；input 携带 terminalId、递增 sequence 和 data，执行命令以 \\r 结尾。",
    `- 读取输出：GET ${base}/api/lan-agent/instances/<instanceId>/terminals/<terminalId>?after=<nextOutputSequence>&waitMs=25000；返回 terminal、outputEvents、nextOutputSequence、truncated。`,
    `- 文件与画面：POST ${base}/api/lan-agent/instances/<instanceId>/computer；按 capabilities 中 remote-computer 合同读取分块文件、上传文件、查询窗口和截图。`,
    "这些接口由远端客户端直接执行，不依赖 Codex、DSH 或其他 Agent 后端启动。客户端及主控连接必须在线。",
    "超时先查询现有终端和 nextInputSequence，不自动重建或重发输入；输出有界，重要结果应写文件后互传。"
  ];
}

function managerBaseUrl(context: AgentCapabilityHintContext): string {
  const rawPort = String(context.managerPort || "").trim();
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) {
    throw new Error("A valid current Manager port is required for Agent capability hints.");
  }
  const port = Number(rawPort);
  if (port > 65535) {
    throw new Error("A valid current Manager port is required for Agent capability hints.");
  }
  return `http://127.0.0.1:${port}`;
}

export function voiceIdentityReviewCapabilityHint(
  text: string,
  context: AgentCapabilityHintContext
): string[] | null {
  if (!VOICE_IDENTITY_INTENT_PATTERN.test(text)) return null;
  const baseUrl = managerBaseUrl(context);
  const rolePath = encodeURIComponent(context.roleId);
  return [
    "主机只保存不透明声纹、分段和模型证据，不判断是谁，也不判断谁是用户；归类结论只属于当前人格。",
    `- 查询当前人格语音归类：GET ${baseUrl}/api/roles/${rolePath}/voice-transcripts?from=<ISO>&to=<ISO>&speaker=<user|other|unknown|conflict>&limit=200`,
    "省略 speaker 可同时取得 user/other/unknown/conflict 汇总；matchedCount 和 summary 基于完整筛选结果，不受明细 limit 截断。",
    `- 查询语音消息端账号的兼容归类：GET ${baseUrl}/api/roles/${rolePath}/voice-identities`,
    `- 确认或修正语音账号归类：PUT ${baseUrl}/api/roles/${rolePath}/voice-identities`,
    "关系写入示例：",
    JSON.stringify({
      sourceHostId: "<从语音记录取得>",
      voiceprintId: "<不透明声纹 ID>",
      displayName: "<当前人格理解的称呼>",
      relationship: "<与当前人格的关系>",
      isUser: "<确认后填 true/false；不确定时省略>"
    }, null, 2),
    "只根据当前人格自己的会话、记忆、用户确认和关系证据判断；证据不足时保持 unknown，不把主机候选或高分直接当作用户。",
    "PUT 会追加关系事件并显式收敛当前并发分支，不重写原始语音；只执行当前请求需要的查询，不周期轮询覆盖率。"
  ];
}
