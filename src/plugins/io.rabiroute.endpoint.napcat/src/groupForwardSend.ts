import type { MessageEndpointSendVariant, MessageEndpointVariantSendInput } from "@rabiroute/plugin-sdk";
import { messageAdapterPolicyFor, normalizeNapCatInstances, type GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { callNapCat, getLoginInfo } from "./napcat.js";

const type = "napcat.group-forward";
const groupForwardVariant: MessageEndpointSendVariant = Object.freeze({
  type, contractVersion: 1, description: "向指定 QQ 群发送由当前机器人署名的纯文本合并转发。需要确切的群号和 NapCat 实例。",
  operation: "sendGroupForwardVariant",
  paramsSchema: { type: "object", additionalProperties: false, required: ["target", "groupId", "instanceId"], properties: {
    target: { const: "group" }, groupId: { type: "string", pattern: "^[1-9][0-9]*$" }, instanceId: { type: "string", pattern: "^\\S+$" }
  } },
  dataSchema: { type: "object", additionalProperties: false, required: ["nodes"], properties: {
    nodes: { type: "array", minItems: 1, items: { type: "string", pattern: "\\S" } }
  } },
  readText: data => (data.nodes as string[]).join("\n\n")
});

export function createNapcatGroupForward(readRoute: (id: string) => GatewayDefinition | undefined) {
  return {
    variant: groupForwardVariant,
    async sendGroupForwardVariant(input: MessageEndpointVariantSendInput) {
      const { groupId, instanceId, replyToMessageId, target } = input.target;
      if (target !== "group" || typeof groupId !== "string" || !/^[1-9][0-9]*$/.test(groupId)
        || typeof instanceId !== "string" || !instanceId || replyToMessageId) {
        throw new Error("Group forward requires an explicit group and NapCat instance, without a quoted reply.");
      }
      const route = readRoute(input.gatewayId);
      const selectedProfile = route?.routeProfiles?.find(profile => profile.id === input.routeId);
      const ownsRoute = selectedProfile ? selectedProfile.enabled !== false
        : (route?.routeProfiles?.length ?? 0) <= 1 && [route?.id, route?.configName].includes(input.routeId);
      if (!route || route.enabled === false || !ownsRoute || !route.messageAdapters?.includes("napcat")
        || route.messageAdaptersDisabled?.includes("napcat")) throw new Error("The original NapCat Route is unavailable.");
      const policy = messageAdapterPolicyFor(route, "napcat");
      if (!policy.outputEnabled || !policy.supportedOutputs.includes("text")) throw new Error("The original NapCat Route no longer allows text output.");
      const instance = normalizeNapCatInstances(route).find(row => row.id === instanceId && row.enabled !== false);
      if (!instance?.httpUrl) throw new Error("The selected NapCat instance is unavailable.");
      const endpoint = { httpUrl: instance.httpUrl, accessToken: instance.accessToken ?? "" };
      const login = await getLoginInfo(endpoint, { timeoutMs: 5000 });
      const userId = String(login.userId ?? "");
      if (!/^[1-9][0-9]*$/.test(userId) || instance.botUserId && String(instance.botUserId) !== userId
        || readRoute(input.gatewayId) !== route) throw new Error("The original NapCat account or Route changed before forwarding.");
      const nodes = input.data.nodes as string[];
      const response = await callNapCat<{ data?: { message_id?: unknown } }>("send_group_forward_msg", {
        group_id: groupId,
        messages: nodes.map(text => ({ type: "node", data: { user_id: userId, nickname: login.nickname || userId,
          content: [{ type: "text", data: { text } }] } }))
      }, endpoint, { timeoutMs: 30_000 });
      const messageId = response.data?.message_id;
      if (typeof messageId !== "string" && typeof messageId !== "number" || !String(messageId).trim()) {
        throw new Error("NapCat returned no message ID for the original group forward.");
      }
      return { messageId: String(messageId) };
    }
  };
}
