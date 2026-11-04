import fs from "node:fs";
import path from "node:path";
import type { EndpointDeliveryReceipt } from "./endpointDelivery.js";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "./nativeOwnerDelivery.js";
import type { AgentThreadRequestOptions } from "../agentThreads.js";
import { invokeScopedAgentManagerOperation, withAgentManagerInvocation } from "../agentAdapters/managerInvocation.js";

/** A concrete host directory is execution context, never a configured-workspace grant. */
export function assertEndpointOwnerDirectory(cwd: string | undefined): asserts cwd is string {
  if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Endpoint execution requires an existing absolute owner directory.");
  }
}

export async function recoverEndpointOwnerReceipt(delivery: NativeOwnerDeliveryEvidence, assertAuthorized: () => void | Promise<void>): Promise<EndpointDeliveryReceipt | undefined> {
  return invokeScopedAgentManagerOperation(delivery.target.provider, "endpoint.recover", { delivery }, { nativeArgs: [delivery, assertAuthorized] });
}

/** Business authority and frozen delivery remain on the original host; only native I/O is delegated. */
export async function executeEndpointOnOwner(
  delivery: NativeOwnerDelivery,
  options: Pick<AgentThreadRequestOptions, "dshBaseUrl" | "invokeAgentOperation" | "getProviders"> & { allowedWorkspaces?: string[] },
  assertAuthorized: () => void | Promise<void>,
  transport?: { sendCodex: typeof import("../codexRuntime.js").sendCodexThreadMessage }
): Promise<{ threadId: string; action: string; transport: string }> {
  await assertAuthorized();
  assertEndpointOwnerDirectory(delivery.executionOptions.cwd);
  const execute = () => invokeScopedAgentManagerOperation<{ threadId: string; action: string; transport: string }>(
    delivery.target.provider, "endpoint.execute", { delivery }, { nativeArgs: [delivery, options, assertAuthorized, transport] }
  );
  return options.invokeAgentOperation ? withAgentManagerInvocation(options, execute) : execute();
}
