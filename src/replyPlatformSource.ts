import { agentReplyCurrentQqBinding, agentReplyDataDirsForRoute, type AgentReplyOptions } from "./outbox.js";
import { resolveAgentSendRoute } from "./agentSendRoute.js";
import { needsPlatformReplySource, type PlatformReplySourceEvidence, type ReplyImageDescriptionSend } from "./replyImageDescriptions.js";

/** Fetch through the published QQ owner, never through caller-supplied source metadata. */
export async function readPlatformReplySource(input: ReplyImageDescriptionSend, options: AgentReplyOptions,
  assertRouteCurrent: () => void): Promise<PlatformReplySourceEvidence | undefined> {
  if (!needsPlatformReplySource(input, options)) return undefined;
  const route = resolveAgentSendRoute(options.runtimes, input.routeId);
  if (!route) throw new Error("Quoted QQ source Route is unavailable.");
  const instanceId = String(input.target.instanceId ?? "").trim();
  const instances = (route.runtime.napcatInstances ?? []).filter(item => item.enabled !== false);
  const instance = instances.find(item => item.id === instanceId);
  if (!instance) throw new Error("Quoted QQ source requires the exact enabled instanceId.");
  const provider = options.endpointEgress?.("endpoint.napcat.egress@1");
  if (!provider) throw new Error("Quoted QQ source requires the published NapCat provider.");
  const bindingRequest = { explicitTarget: true, routeProfileId: input.routeId, groupId: String(input.target.groupId), instanceId };
  const binding = agentReplyCurrentQqBinding(bindingRequest, options);
  if (!binding) throw new Error("Quoted QQ source requires the current exact Route binding.");
  const endpoint = binding.endpoint;
  const assertCurrent = () => {
    assertRouteCurrent();
    if (options.endpointEgress?.("endpoint.napcat.egress@1") !== provider
      || agentReplyCurrentQqBinding(bindingRequest, options)?.bindingRevision !== binding.bindingRevision) {
      throw new Error("Quoted QQ source provider changed; fetch the source from the current Route before sending.");
    }
  };
  assertCurrent();
  const dataDirs = agentReplyDataDirsForRoute(options, route);
  const sourceMessageId = String(input.target.replyToMessageId).trim(), groupId = String(input.target.groupId).trim();
  const lease = provider.acquire({ routeId: input.routeId, instanceId, groupId, sourceMessageId });
  try {
    const record = await lease.call<Record<string, unknown>>("readReplySource", [{ endpoint, groupId,
      messageId: sourceMessageId, instanceId, dataDir: dataDirs[0] }]);
    assertCurrent();
    return { routeId: input.routeId, sourceMessageId, groupId, instanceId, record, dataDirs, assertCurrent };
  } finally { lease.release(); }
}
