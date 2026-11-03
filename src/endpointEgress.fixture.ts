import * as napcat from "./napcat.js";
import * as wecom from "./wecom.js";
import * as feishu from "./feishu.js";
import * as weixin from "./weixinOpenClaw.js";
import * as rabilink from "./adapters/rabilinkRelayWorker.js";
import * as speech from "./speech/localSpeechClient.js";
import { handleAgentReply as reply, type AgentReplyOptions } from "./outbox.js";
import { handleAgentSend as send } from "./agentSend.js";
import type { MessageEndpointEgressProvider } from "@rabiroute/plugin-sdk";
export * from "./outbox.js";
export * from "./agentSend.js";
/** Explicit unit protocol fixture. Production always resolves a native published provider. */
export function withTestEndpointEgress(options: AgentReplyOptions): AgentReplyOptions {
  const protocols: Record<string, object> = {napcat,wecom,feishu,weixin,rabilink,speech};
  return {...options, endpointEgress: capability => {
    const type = /^endpoint\.(.+)\.egress@1$/.exec(capability)?.[1];
    const owner = type && protocols[type];
    if (!owner) return undefined;
    return { acquire(snapshot) { return {snapshot, async call<T>(operation: string, args: readonly unknown[]) {
      const method = (owner as Record<string, (...args: any[]) => unknown>)[operation];
      if (!method) throw new Error(operation);
      return await method(...args) as T;
    }, release() {}}; }} as MessageEndpointEgressProvider;
  }};
}
export const handleAgentReply: typeof reply = (request, options) => reply(request, withTestEndpointEgress(options));
export const handleAgentSend: typeof send = (request, options, ...rest) => send(request, withTestEndpointEgress(options), ...rest);
