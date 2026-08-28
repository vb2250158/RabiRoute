import { parseAgentAdapterType, type AgentAdapterType } from "./agentAdapters/types.js";
import type { RabiDeliveryEnvelope } from "./shared/rabiMessage.js";

export const AGENT_DELIVERY_TEST_RESULT_PREFIX = "RABIROUTE_AGENT_DELIVERY_TEST_RESULT:";

export type AgentDeliveryTestStatus = "delivered" | "failed";

export type AgentDeliveryTestResult = {
  deliveryId: string;
  gatewayId: string;
  agentAdapterType: AgentAdapterType;
  status: AgentDeliveryTestStatus;
  completedAt: string;
  error?: string;
};

export function buildAgentDeliveryTestEnvelope(options: {
  deliveryId: string;
  gatewayId: string;
  routeName?: string;
  agentAdapterType: AgentAdapterType;
}): RabiDeliveryEnvelope {
  const routeName = options.routeName?.trim() || options.gatewayId;
  return {
    messageSource: {
      type: "system",
      eventType: "agent_delivery_test",
      eventName: "通道投递测试",
      eventId: options.deliveryId,
      actorType: "manager",
      actorName: "Rabi Manager",
      actorId: "rabi-manager",
      routeName,
      routeId: options.gatewayId
    },
    messageContent: [
      "[通道投递测试]",
      "这是 RabiRoute 消息配置页发起的真实可达性测试。",
      `目标 Agent：${options.agentAdapterType}`,
      `测试编号：${options.deliveryId}`,
      "",
      "收到后无需回复，也不要执行其他操作。",
      "",
      `[投递编号]`,
      `deliveryId: ${options.deliveryId}`
    ].join("\n")
  };
}

export function serializeAgentDeliveryTestResult(result: AgentDeliveryTestResult): string {
  return `${AGENT_DELIVERY_TEST_RESULT_PREFIX}${JSON.stringify(result)}`;
}

export function parseAgentDeliveryTestResult(output: string): AgentDeliveryTestResult | null {
  const line = output.split(/\r?\n/)
    .reverse()
    .find(item => item.startsWith(AGENT_DELIVERY_TEST_RESULT_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(AGENT_DELIVERY_TEST_RESULT_PREFIX.length)) as Partial<AgentDeliveryTestResult>;
    const agentAdapterType = parseAgentAdapterType(parsed.agentAdapterType);
    if (!parsed.deliveryId || !parsed.gatewayId || !agentAdapterType || !parsed.status || !parsed.completedAt) {
      return null;
    }
    if (parsed.status !== "delivered" && parsed.status !== "failed") return null;
    return {
      deliveryId: parsed.deliveryId,
      gatewayId: parsed.gatewayId,
      agentAdapterType,
      status: parsed.status,
      completedAt: parsed.completedAt,
      ...(parsed.error ? { error: parsed.error } : {})
    };
  } catch {
    return null;
  }
}

