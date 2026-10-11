import { readRolloutUserMessages } from "./rolloutReceipt.js";
import { agentDeliveryPromptHash } from "./store.js";
import { deliveryIdFromPrompt } from "../shared/deliveryIdentity.js";
import type { PreparedEndpointDelivery, EndpointDeliveryReceipt } from "./endpointDelivery.js";
import { sendCodexThreadMessage } from "../codexRuntime.js";
import { readCodexDesktopThread } from "../codexDesktopBridge.js";
import { readDshSession, sendDshSessionMessage } from "../dshSessionBridge.js";
import { readWorkbuddyThread, sendWorkbuddyThreadMessage } from "../workbuddyThreads.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import type { AgentThreadRequestOptions } from "../agentThreads.js";
import fs from "node:fs";
import path from "node:path";

/** A concrete host directory is execution context, never a configured-workspace grant. */
export function assertEndpointOwnerDirectory(cwd: string | undefined): asserts cwd is string {
  if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Endpoint execution requires an existing absolute owner directory.");
  }
}

export async function recoverEndpointOwnerReceipt(delivery: PreparedEndpointDelivery, assertAuthorized: () => void | Promise<void>): Promise<EndpointDeliveryReceipt | undefined> {
  await assertAuthorized();
  if (delivery.target.provider !== "codex") return undefined;
  const owner = readCodexDesktopThread(delivery.target.sessionId);
  if (!owner || owner.archived || !owner.rolloutPath) return undefined;
  await assertAuthorized();
  for await (const prompt of readRolloutUserMessages(owner.rolloutPath)) {
    await assertAuthorized();
    if (deliveryIdFromPrompt(prompt) === delivery.deliveryId && agentDeliveryPromptHash(prompt) === delivery.promptHash) {
      return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
        accepted: true, action: "receipt_recovered", transport: "desktop-ipc" };
    }
  }
  await assertAuthorized();
  return undefined;
}

/** Executes the already-rendered Manager envelope on the exact existing owner; never resolves/replaces it. */
export async function executeEndpointOnOwner(delivery: PreparedEndpointDelivery, options: Pick<AgentThreadRequestOptions, "dshBaseUrl"> & { allowedWorkspaces?: string[] },
  assertAuthorized: () => void | Promise<void>): Promise<{ threadId: string; action: string; transport: string }> {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox, dshDeliveryMode } = delivery.executionOptions;
  await assertAuthorized();
  assertEndpointOwnerDirectory(cwd);
  if (endpoint.provider === "codex") {
    const thread = readCodexDesktopThread(endpoint.sessionId);
    if (!thread || thread.archived || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact Codex owner is unavailable.");
    return sendCodexThreadMessage({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd,
      sandbox: sandbox ?? "workspace-write", model, reasoningEffort, assertAuthorized });
  }
  if (endpoint.provider === "dsh") {
    if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined) throw new Error("DSH owner protocol cannot apply model, reasoningEffort or sandbox.");
    const thread = await readDshSession(endpoint.sessionId, options.dshBaseUrl, assertAuthorized);
    await assertAuthorized();
    if (!thread || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact DSH owner is unavailable.");
    return sendDshSessionMessage({ sessionId: endpoint.sessionId, prompt: delivery.prompt, cwd, baseUrl: options.dshBaseUrl,
      requestId: delivery.deliveryId, mode: dshDeliveryMode, assertAuthorized });
  }
  if (endpoint.provider === "workbuddy") {
    if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined || dshDeliveryMode !== undefined) throw new Error("WorkBuddy owner protocol cannot apply model, reasoningEffort, sandbox or dshDeliveryMode.");
    const thread = readWorkbuddyThread(endpoint.sessionId) as { cwd?: string };
    if (!thread || !thread.cwd || !sameCodexWorkspace(thread.cwd, cwd)) throw new Error("Exact WorkBuddy owner is unavailable.");
    return sendWorkbuddyThreadMessage({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd, assertAuthorized });
  }
  throw new Error("The enabled provider has no exact owner execution capability; no alternate Runtime was started.");
}
