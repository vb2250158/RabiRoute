import { createAgentProtocol } from '../../../packages/assistant-runtime/src/decision-protocol.js';
export { canonicalAgentIntent, getAgentProtocolFailureReason } from '../../../packages/assistant-runtime/src/decision-protocol.js';

export const rabiAgentProtocol = createAgentProtocol({
  id: 'rabi-agent/v1',
  introduction: '你通过 Rabi 应用管理的 Agent 循环执行任务，使用乐奇宿主配置的模型。普通最终回答可以直接使用自然语言。',
  toolInstructions: '先用 rabi_api_help 分页查索引，沿 nextCursor 保持原筛选与目标继续；找到后指定 operationId 读完整合同，再用 rabi_api_call 调用。目录不是权限白名单；索引不含完整参数。游标或目录代际变化时重新查询，不拼接不同快照。requestIdentity 是本地原请求标识，不是业务完成回执。结果未确认或 resultAvailable=false 时，在原 targetDeviceId 按已查合同使用真实的原 operationId、deliveryId、requestId 或资源键查询；这些编号不能互换，缺少编号或查询接口就报告未确认。duplicate/completed 仅表示本地已有传输记录，不能补造原结果或换编号重做。异步任务已经受理且合同提供原任务GET状态查询时，可用 rabi_task_follow 登记原编号、路径和实际终态；后台只读跟进后通知，继续接收用户对话。不要登记整个任务列表、编造状态字段或用跟进代替后端取消。'
});
export const AGENT_PROTOCOL = rabiAgentProtocol.id;
export const agentLoopModelOptions = rabiAgentProtocol.modelOptions;
export const parseAgentDecision = rabiAgentProtocol.parseDecision;
export const agentInput = rabiAgentProtocol.input;
