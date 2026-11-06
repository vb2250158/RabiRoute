import type { IncomingMessage } from "node:http";
import type { AgentThreadRequest } from "../agentThreads.js";
import { resolvePlanHistoryActor } from "../shared/planHistoryActor.js";
import { getTrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

/** Attribution uses the admitted source node, never a current plan binding or body-supplied coordinates. */
export async function resolvePlanHistoryRequestActor(request: IncomingMessage, messageSource: unknown, options: {
  verifiedUserEntry: boolean;
  readThread(query: AgentThreadRequest): Promise<{ id: string; title: string; cwd?: string; archived?: boolean; baseUrl?: string }>;
}) {
  const source = getTrustedLanAgentSource(request);
  return resolvePlanHistoryActor(messageSource, {
    verifiedUserEntry: options.verifiedUserEntry && !source,
    readAgent: async identity => {
      const instanceBinding = source ? { instanceId: source.nodeId, agentId: source.agentId } : undefined;
      const owner = await options.readThread({ action: "read", agentAdapter: identity.agentAdapter, threadId: identity.sessionId, cwd: identity.workspace,
        ...(instanceBinding ? { instanceBinding } : {}) });
      return { ...owner, ...(instanceBinding ? { instanceBinding } : {}) };
    }
  });
}
