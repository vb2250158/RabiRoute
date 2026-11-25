import { setTimeout as sleep } from "node:timers/promises";
import { prepareCodexDesktopQueue } from "./codexDesktopQueue.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readRolloutUserMessages } from "../agentRequests/rolloutReceipt.js";
import { agentDeliveryPromptHash } from "@rabiroute/host-api/agentRequests/store";
import { deliveryIdFromPrompt } from "@rabiroute/host-api/shared/deliveryIdentity";
import type { CodexNativeOperations } from "@rabiroute/host-api/agentAdapters/codexContracts";
import { CodexDesktopPromptNotSentError, codexDesktopLateStartAccepted, readCodexDesktopThread } from "../codexDesktopBridge.js";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";
import type { EndpointDeliveryReceipt } from "@rabiroute/host-api/agentRequests/endpointDelivery";
import type { NativeOwnerDelivery, NativeOwnerDeliveryEvidence } from "@rabiroute/host-api/agentRequests/nativeOwnerDelivery";
import type { AgentThreadRequestOptions } from "@rabiroute/host-api/agentThreads";
import { assertEndpointOwnerDirectory } from "@rabiroute/host-api/agentRequests/ownerExecution";
import { sameCodexWorkspace } from "@rabiroute/host-api/codexTaskIdentity";
import { agentWorkspaceMismatch } from "@rabiroute/host-api/agentRequests/requestValidation";
export async function recoverEndpointOwnerReceipt(delivery: NativeOwnerDeliveryEvidence, assertAuthorized: () => void | Promise<void>,
  selectedTransport?: "desktop-ipc" | "desktop-queue"): Promise<EndpointDeliveryReceipt | undefined> {
  await assertAuthorized();
  if (delivery.target.provider !== "codex") return undefined;
  if (selectedTransport !== "desktop-queue" && codexDesktopLateStartAccepted(delivery.target.sessionId, delivery.deliveryId)) {
    await assertAuthorized();
    return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
      accepted: true, action: "receipt_recovered", transport: "desktop-ipc" };
  }
  const owner = readCodexDesktopThread(delivery.target.sessionId);
  if (!owner || !owner.rolloutPath) return undefined;
  await assertAuthorized();
  const { withoutLegacyTransportSuffix } = await import("@rabiroute/host-api/shared/deliveryIdentity");
  for await (const prompt of readRolloutUserMessages(owner.rolloutPath, owner.id, undefined, delivery.deliveryId)) {
    const prefix = withoutLegacyTransportSuffix(prompt);
    // Historical Desktop transports added a UUID after the frozen Manager envelope.
    // Recovery still requires the original structured identity and exact reserved bytes.
    const exactEvidence = deliveryIdFromPrompt(prompt) === delivery.deliveryId && agentDeliveryPromptHash(prompt) === delivery.promptHash
      || (selectedTransport !== "desktop-queue" && prefix !== undefined && deliveryIdFromPrompt(prefix) === delivery.deliveryId && agentDeliveryPromptHash(prefix) === delivery.promptHash);
    if (exactEvidence) {
      // Historical messages are local evidence, not separate execution steps.
      // Recheck the current grant before accepting evidence, without a remote
      // authority round trip for every unrelated message in a long rollout.
      await assertAuthorized();
      return { deliveryId: delivery.deliveryId, generation: delivery.generation, endpoint: delivery.target, promptHash: delivery.promptHash, executionOptionsHash: delivery.executionOptionsHash,
        accepted: true, action: "receipt_recovered", transport: selectedTransport ?? "desktop-ipc" };
    }
  }
  await assertAuthorized();
  return undefined;
}

export async function executeEndpointOnOwner(delivery: NativeOwnerDelivery, _options: Pick<AgentThreadRequestOptions, "dshBaseUrl">,
  assertAuthorized: () => void | Promise<void>, transport: { sendCodex: CodexNativeOperations["sendCodexThreadMessage"]; ipcReady?: () => Promise<boolean>;
    selectTransport?: (transport: "desktop-ipc" | "desktop-queue") => void },
  queue = { platform: process.platform, prepare: prepareCodexDesktopQueue, wait: () => sleep(2_000) }) {
  const endpoint = delivery.target;
  const { cwd, model, reasoningEffort, sandbox, codexDeliveryMode } = delivery.executionOptions;
  await assertAuthorized();
  const thread = readCodexDesktopThread(endpoint.sessionId);
  if (!thread || thread.id !== endpoint.sessionId || thread.archived) {
    throw new EndpointDeliveryNotSentError("Exact Codex owner is unavailable.");
  }
  try {
    if (endpoint.kind === "local") {
      if (!cwd || !path.isAbsolute(cwd)) throw new Error("Endpoint execution requires an absolute owner directory.");
      // Windows drive mappings and SMB credentials are scoped to a logon token.
      // Desktop receives the configured path and resolves it in its own session.
      if (process.platform !== "win32" && !(await fs.stat(cwd)).isDirectory()) {
        throw new Error("Endpoint execution requires an existing owner directory.");
      }
    } else {
      assertEndpointOwnerDirectory(cwd);
    }
  } catch (error) {
    throw new EndpointDeliveryNotSentError(error);
  }
  if (endpoint.kind !== "local" && !sameCodexWorkspace(thread.cwd, cwd)) throw agentWorkspaceMismatch(endpoint);
  if (queue.platform === "win32" && transport.selectTransport && transport.ipcReady && !await transport.ipcReady()) {
    let enqueue: Awaited<ReturnType<typeof prepareCodexDesktopQueue>>;
    try {
      if (model !== undefined || reasoningEffort !== undefined || sandbox !== undefined || delivery.executionOptions.localImages?.length) {
        throw new Error("Codex Desktop queue uses the original task settings and cannot apply a per-delivery model, reasoning effort, sandbox or attachments.");
      }
      if (deliveryIdFromPrompt(delivery.prompt) !== delivery.deliveryId || thread.parentThreadId || !sameCodexWorkspace(thread.cwd, cwd)) {
        throw new Error("Codex Desktop queue requires the original marked root task in its own workspace.");
      }
      enqueue = await queue.prepare({ threadId: thread.id, cwd, rolloutPath: thread.rolloutPath, prompt: delivery.prompt });
    } catch (error) {
      throw new EndpointDeliveryNotSentError(error);
    }
    await assertAuthorized();
    transport.selectTransport("desktop-queue");
    try { await enqueue(assertAuthorized); }
    catch {
      // A timed-out or failed CLI may already have written the queue record.
      // The original transport remains pinned while its owner evidence is read.
    }
    for (let check = 0; check < 6; check++) {
      if (await recoverEndpointOwnerReceipt(delivery, assertAuthorized, "desktop-queue")) {
        return { threadId: thread.id, action: "started", transport: "desktop-queue" };
      }
      if (check < 5) await queue.wait();
    }
    throw new Error("Codex Desktop queue acceptance remains unconfirmed. Reconcile the original delivery.");
  }
  try {
    await assertAuthorized();
    transport.selectTransport?.("desktop-ipc");
    return await transport.sendCodex({ threadId: endpoint.sessionId, prompt: delivery.prompt, cwd,
      imagePaths: delivery.executionOptions.localImages?.map(image => image.path),
      sandbox: sandbox ?? "workspace-write", model, reasoningEffort, assertAuthorized,
      ...(codexDeliveryMode ? { deliveryMode: codexDeliveryMode } : {}) });
  } catch (error) {
    if (error instanceof CodexDesktopPromptNotSentError) throw new EndpointDeliveryNotSentError(error);
    throw error;
  }
}
