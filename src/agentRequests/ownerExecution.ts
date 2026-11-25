import fs from "node:fs";
import path from "node:path";
import type { EndpointDeliveryReceipt } from "./endpointDelivery.js";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "./nativeOwnerDelivery.js";
import type { AgentThreadRequestOptions } from "../agentThreads.js";
import { verifyLocalDeliveryImages } from "./localDeliveryImages.js";
import { EndpointDeliveryNotSentError } from "./deliveryFailure.js";
import { agentAdapterSupportsManagedTaskFeature } from "../shared/agentAdapterCapabilities.js";
import { invokeScopedAgentManagerOperation, withAgentManagerInvocation } from "../agentAdapters/managerInvocation.js";

/** A concrete host directory is execution context, never a configured-workspace grant. */
export function assertEndpointOwnerDirectory(cwd: string | undefined): asserts cwd is string {
  if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Endpoint execution requires an existing absolute owner directory.");
  }
}

export type EndpointOwnerTransport = {
  sendCodex?: import("../agentAdapters/codexContracts.js").CodexNativeOperations["sendCodexThreadMessage"];
  selectTransport?: (selected: "desktop-ipc" | "desktop-queue") => void;
};

export async function recoverEndpointOwnerReceipt(delivery: NativeOwnerDeliveryEvidence, assertAuthorized: () => void | Promise<void>,
  selectedTransport?: "desktop-ipc" | "desktop-queue"): Promise<EndpointDeliveryReceipt | undefined> {
  return invokeScopedAgentManagerOperation(delivery.target.provider, "endpoint.recover", { delivery }, { nativeArgs: [delivery, assertAuthorized, selectedTransport] });
}

/** Business authority and frozen delivery remain on the original host; only native I/O is delegated. */
export async function executeEndpointOnOwner(
  delivery: NativeOwnerDelivery,
  options: Pick<AgentThreadRequestOptions, "dshBaseUrl" | "invokeAgentOperation" | "getProviders"> & { allowedWorkspaces?: string[] },
  assertAuthorized: () => void | Promise<void>,
  transport?: EndpointOwnerTransport
): Promise<{ threadId: string; action: string; transport: string }> {
  await assertAuthorized();
  // The exact local Codex Desktop owner resolves its execution directory in its own context.
  if (delivery.target.kind !== "local" || delivery.target.provider !== "codex") {
    try { assertEndpointOwnerDirectory(delivery.executionOptions.cwd); }
    catch (error) { throw new EndpointDeliveryNotSentError(error); }
  }
  if (delivery.executionOptions.localImages) {
    try {
      if (delivery.target.kind !== "local") throw new Error("Local images cannot cross an instance boundary.");
      if (!agentAdapterSupportsManagedTaskFeature(delivery.target.provider, "imageAttachments")) throw new Error("This Agent owner does not support image attachments.");
      verifyLocalDeliveryImages(delivery.executionOptions.localImages);
    } catch (error) { throw new EndpointDeliveryNotSentError(error); }
  }
  const execute = () => invokeScopedAgentManagerOperation<{ threadId: string; action: string; transport: string }>(
    delivery.target.provider, "endpoint.execute", { delivery }, { nativeArgs: [delivery, options, assertAuthorized, transport] }
  );
  return options.invokeAgentOperation ? withAgentManagerInvocation(options, execute) : execute();
}
