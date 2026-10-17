import fs from "node:fs/promises";
import path from "node:path";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { createHash, randomUUID } from "node:crypto";
import { renderRabiDelivery, type RabiDeliveryEnvelope } from "../shared/rabiMessage.js";
import type { AgentAdapter } from "./contracts.js";
import { reportAgentState } from "./stateReporter.js";
import { decodeGrokBotSessionId, encodeGrokBotSessionId, grokBotMessageId, GrokBotClient, GrokBotError,
  type GrokBotClientOptions, type GrokBotDeliveryOptions, type GrokBotSendReceipt } from "./grokBotClient.js";

export type GrokBotAdapterConfiguration = GrokBotClientOptions & {
  agentId?: string;
  sessionId?: string;
  sessionName?: string;
  dataDir?: string;
};
export type GrokBotAdapterDependencies = {
  client?: Pick<GrokBotClient, "sendNative" | "getSendStatus" | "profileStatus">;
  writeState?: (state: Record<string, unknown>) => Promise<void>;
  reportState?: (state: Record<string, unknown>) => void;
};
export function grokBotConfigurationFromEnvironment(): GrokBotAdapterConfiguration {
  return { agentId: process.env.GROK_BOT_AGENT_ID?.trim(), sessionId: process.env.GROK_BOT_SESSION_ID?.trim(),
    sessionName: process.env.GROK_BOT_SESSION_NAME?.trim(),
    profilePath: process.env.GROK_BOT_PROFILE_PATH?.trim(), backendUrl: process.env.GROK_BOT_BACKEND_URL?.trim() || undefined,
    dataDir: process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data") };
}
export function resolveGrokBotConfiguredSession(configuration: GrokBotAdapterConfiguration): { agentId: string; sessionId: string; defaultMain?: true; id: string } {
  if (!configuration.sessionId) throw new GrokBotError("GROK_BOT_SESSION_REQUIRED");
  if (configuration.sessionId.startsWith("grokBot:")) {
    const bound = decodeGrokBotSessionId(configuration.sessionId);
    if (configuration.agentId && bound.agentId !== configuration.agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
    return { ...bound, id: configuration.sessionId };
  }
  if (!configuration.agentId) throw new GrokBotError("GROK_BOT_AGENT_REQUIRED");
  return { agentId: configuration.agentId, sessionId: configuration.sessionId,
    id: encodeGrokBotSessionId(configuration.agentId, configuration.sessionId) };
}
function auditTransportFile(file: string, action: string, outcome: "started" | "committed" | "no_change" | "failed"): void {
  const id = createHash("sha256").update(path.resolve(file)).digest("hex");
  recordDataMutationAudit({ group: "agent-delivery", event: "grok_bot_transport_mutation", owner: "grok-bot",
    action, outcome, target: { type: "transport-record", id }, dataSource: { kind: "file", id } });
}
async function writeGrokBotState(dataDir: string, state: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "grokbot-agent-state.json");
  const temporary = file + "." + randomUUID() + ".tmp";
  auditTransportFile(file, "state", "started");
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
    auditTransportFile(file, "state", "committed");
  } catch (error) {
    auditTransportFile(file, "state", "failed");
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
}
type TransportAttempt = { version: 1; messageId: string; promptHash: string; accountScope: string; attemptedAt: string; deliveryOptionsHash?: string };
type TransportReceipt = TransportAttempt & { status: "accepted" | "rejected"; completedAt: string; recovered?: boolean; duplicate?: boolean; echoEntryId?: string };
const transportLockKey = Symbol.for("rabi.grokBot.transport-receipt-locks.v1");
const transportGlobals = globalThis as unknown as Record<symbol, Map<string, Promise<void>>>;
const transportLocks = transportGlobals[transportLockKey] ??= new Map<string, Promise<void>>();
async function withTransportLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = transportLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>(done => { release = done; });
  transportLocks.set(key, current);
  await previous?.catch(() => {});
  try { return await action(); }
  finally { release(); if (transportLocks.get(key) === current) transportLocks.delete(key); }
}
async function readTransportRecord(file: string): Promise<TransportAttempt | TransportReceipt | undefined> {
  try {
    if ((await fs.stat(file)).size > 16 * 1024) throw new Error();
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as TransportAttempt | TransportReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new GrokBotError("GROK_BOT_JOURNAL_UNAVAILABLE");
  }
}
function verifyTransportRecord(value: TransportAttempt, expected: TransportAttempt): void {
  if (value.version !== 1 || value.messageId !== expected.messageId || typeof value.attemptedAt !== "string") throw new GrokBotError("GROK_BOT_JOURNAL_UNAVAILABLE");
  if (value.promptHash !== expected.promptHash) throw new GrokBotError("GROK_BOT_DELIVERY_ID_CONFLICT");
  if (value.deliveryOptionsHash !== expected.deliveryOptionsHash) throw new GrokBotError("GROK_BOT_DELIVERY_ID_CONFLICT");
  if (value.accountScope !== expected.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
}
async function reserveTransportAttempt(file: string, attempt: TransportAttempt): Promise<boolean> {
  auditTransportFile(file, "reserve", "started");
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(attempt)); await handle.sync(); }
    finally { await handle.close(); }
    auditTransportFile(file, "reserve", "committed");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      auditTransportFile(file, "reserve", "no_change");
      return false;
    }
    auditTransportFile(file, "reserve", "failed");
    throw new GrokBotError("GROK_BOT_JOURNAL_UNAVAILABLE");
  }
}
async function commitTransportReceipt(file: string, attemptFile: string, receipt: TransportReceipt): Promise<void> {
  auditTransportFile(file, "receipt", "started");
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    const readback = await readTransportRecord(file);
    if (JSON.stringify(readback) !== JSON.stringify(receipt)) throw new Error();
    await fs.rm(attemptFile, { force: true });
    auditTransportFile(file, "receipt", "committed");
  } catch {
    auditTransportFile(file, "receipt", "failed");
    throw new GrokBotError("GROK_BOT_RECEIPT_STATE_UNCONFIRMED", { uncertain: true });
  }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
/** Immutable attempts survive crashes. Compact terminal receipts have direct ID lookup;
 * unresolved attempts are retained until an authoritative native result arrives. */
export async function deliverWithTransportReceipt(client: NonNullable<GrokBotAdapterDependencies["client"]>, dataDir: string,
  bound: ReturnType<typeof resolveGrokBotConfiguredSession>, deliveryId: string, text: string | undefined,
  options: { grokBotDelivery?: GrokBotDeliveryOptions; reconcileOnly?: boolean } = {}): Promise<GrokBotSendReceipt> {
  if (typeof deliveryId !== "string" || !deliveryId.trim()) throw new GrokBotError("GROK_BOT_DELIVERY_ID_REQUIRED");
  const delivery = options.grokBotDelivery;
  if (delivery && (!["private", "group"].includes(delivery.deliveryType) || !["direct", "identity"].includes(delivery.sendMode)
    || (delivery.sendMode === "identity" ? typeof delivery.senderAgentId !== "string" || !delivery.senderAgentId.trim() : delivery.senderAgentId !== undefined))) {
    throw new GrokBotError("GROK_BOT_DELIVERY_OPTIONS_INVALID");
  }
  if (!options.reconcileOnly && (typeof text !== "string" || !text.trim())) throw new GrokBotError("GROK_BOT_MESSAGE_REQUIRED");
  const messageId = grokBotMessageId(deliveryId, bound.id);
  const directory = path.join(dataDir, "grokbot-transport-receipts", messageId.slice(0, 2));
  const attemptFile = path.join(directory, messageId + ".attempt.json");
  const receiptFile = path.join(directory, messageId + ".receipt.json");
  return withTransportLock(path.resolve(attemptFile), async () => {
    const account = await client.profileStatus();
    const terminal = await readTransportRecord(receiptFile) as TransportReceipt | undefined;
    const prior = terminal ? undefined : await readTransportRecord(attemptFile);
    const expected: TransportAttempt = { version: 1, messageId, accountScope: account.accountScope,
      promptHash: text === undefined && options.reconcileOnly ? (terminal || prior)?.promptHash || "" : createHash("sha256").update(text!).digest("hex"),
      ...(delivery ? { deliveryOptionsHash: createHash("sha256").update(JSON.stringify([delivery.deliveryType, delivery.sendMode, delivery.senderAgentId ?? null])).digest("hex") } : {}),
      attemptedAt: new Date().toISOString() };
    const toReceipt = (value: TransportReceipt): GrokBotSendReceipt => ({ accepted: true, agentId: bound.agentId,
      sessionId: bound.sessionId, messageId, duplicate: true, recovered: value.recovered === true, echoEntryId: value.echoEntryId });
    if (terminal) {
      verifyTransportRecord(terminal, expected);
      if (terminal.status === "rejected") throw new GrokBotError("GROK_BOT_DELIVERY_REJECTED");
      if (terminal.status !== "accepted") throw new GrokBotError("GROK_BOT_JOURNAL_UNAVAILABLE");
      return toReceipt(terminal);
    }
    if (options.reconcileOnly && !prior) throw new GrokBotError("GROK_BOT_DELIVERY_NOT_FOUND");
    if (prior || !await reserveTransportAttempt(attemptFile, expected)) {
      const attempt = prior || await readTransportRecord(attemptFile);
      if (!attempt) throw new GrokBotError("GROK_BOT_JOURNAL_UNAVAILABLE");
      verifyTransportRecord(attempt, expected);
      let status;
      try {
        status = await client.getSendStatus(bound.agentId, bound.sessionId, messageId, account.accountScope, { defaultMain: bound.defaultMain });
        if ((await client.profileStatus()).accountScope !== account.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
      }
      catch { throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true }); }
      if (status.status === "accepted" || status.status === "rejected") {
        const recovered: TransportReceipt = { ...attempt, status: status.status, completedAt: new Date().toISOString(), recovered: true, echoEntryId: status.echoEntryId };
        if (!options.reconcileOnly) await commitTransportReceipt(receiptFile, attemptFile, recovered);
        if (status.status === "rejected") throw new GrokBotError("GROK_BOT_DELIVERY_REJECTED");
        return toReceipt(recovered);
      }
      throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
    }
    let accepted: GrokBotSendReceipt;
    try { accepted = await client.sendNative({ agentId: bound.agentId, sessionId: bound.sessionId, defaultMain: bound.defaultMain, messageId, text: text!,
      ...(delivery ? { deliveryType: delivery.deliveryType, ...(delivery.sendMode === "identity" ? { fromAgentId: delivery.senderAgentId } : {}) } : {}) }, account.accountScope); }
    catch (error) {
      if (error instanceof GrokBotError) throw error;
      throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
    }
    if (!accepted.accepted || accepted.agentId !== bound.agentId || accepted.sessionId !== bound.sessionId || accepted.messageId !== messageId) {
      throw new GrokBotError("GROK_BOT_RECEIPT_OWNER_MISMATCH", { uncertain: true });
    }
    await commitTransportReceipt(receiptFile, attemptFile, { ...expected, status: "accepted", completedAt: new Date().toISOString(),
      recovered: accepted.recovered, duplicate: accepted.duplicate, echoEntryId: accepted.echoEntryId });
    return accepted;
  });
}
/** Every real prompt enters the configured cloud owner through sendNative only. */
export function createGrokBotAdapter(configuration: GrokBotAdapterConfiguration = grokBotConfigurationFromEnvironment(), dependencies: GrokBotAdapterDependencies = {}): AgentAdapter {
  const client = dependencies.client || new GrokBotClient(configuration);
  const writeState = dependencies.writeState || ((state: Record<string, unknown>) => writeGrokBotState(configuration.dataDir || path.join(process.cwd(), "data"), state));
  const reportState = dependencies.reportState || ((state: Record<string, unknown>) => reportAgentState("grokBot", state));
  let notificationCount = 0;
  const inFlight = new Map<string, { fingerprint: string; delivery: Promise<void> }>();
  const report = (state: Record<string, unknown>) => { try { reportState(state); } catch { /* State reporting must not change owner delivery. */ } };
  const persist = async (state: Record<string, unknown>) => {
    try { await writeState(state); }
    catch { throw new GrokBotError("GROK_BOT_STATE_UNAVAILABLE"); }
    report(state);
  };
  const deliver = async (envelope: RabiDeliveryEnvelope): Promise<void> => {
    const baseState: Record<string, unknown> = { agentAdapterType: "grokBot", transport: "native-cloud-owner-http", owner: "grok_bot_cloud",
      notificationCount, lastNotificationAt: new Date().toISOString(), deliveryId: envelope.deliveryId };
    let receipt: GrokBotSendReceipt | undefined;
    try {
      const bound = resolveGrokBotConfiguredSession(configuration);
      if (!envelope.deliveryId) throw new GrokBotError("GROK_BOT_DELIVERY_ID_REQUIRED");
      Object.assign(baseState, { monitorThreadId: bound.id, monitorThreadName: configuration.sessionName || "Grok Bot", bound: true,
        messageId: grokBotMessageId(envelope.deliveryId, bound.id) });
      await persist({ ...baseState, status: "delivering" });
      receipt = await deliverWithTransportReceipt(client, configuration.dataDir || path.join(process.cwd(), "data"), bound, envelope.deliveryId, renderRabiDelivery(envelope));
      notificationCount += 1;
      Object.assign(baseState, { notificationCount, ownerAccepted: receipt.accepted, receiptRecovered: receipt.recovered,
        duplicate: receipt.duplicate, echoEntryId: receipt.echoEntryId });
      try { await persist({ ...baseState, status: "accepted", lastNotificationError: null }); }
      catch { throw new GrokBotError("GROK_BOT_RECEIPT_STATE_UNCONFIRMED", { uncertain: true }); }
    } catch (error) {
      const code = error instanceof GrokBotError ? error.code : "GROK_BOT_ADAPTER_FAILED";
      const uncertain = error instanceof GrokBotError && error.uncertain;
      const failedState = { ...baseState, status: uncertain ? "result-unknown" : "failed", lastNotificationError: code, lastNotificationErrorAt: new Date().toISOString() };
      try { await persist(failedState); }
      catch { report({ ...failedState, statePersistenceError: "GROK_BOT_STATE_UNAVAILABLE" }); }
      if (error instanceof GrokBotError) throw error;
      throw new GrokBotError(code);
    }
  };
  return { type: "grokBot", async deliver(envelope, options) {
    if (options?.imagePaths?.length) throw new GrokBotError("GROK_BOT_IMAGES_UNSUPPORTED");
    const id = envelope.deliveryId;
    if (!id) return deliver(envelope);
    const fingerprint = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
    const previous = inFlight.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new GrokBotError("GROK_BOT_DELIVERY_ID_CONFLICT");
      return previous.delivery;
    }
    const delivery = deliver(envelope);
    inFlight.set(id, { fingerprint, delivery });
    try { await delivery; } finally { if (inFlight.get(id)?.delivery === delivery) inFlight.delete(id); }
  } };
}
export async function notifyGrokBot(envelope: RabiDeliveryEnvelope): Promise<void> {
  await createGrokBotAdapter().deliver(envelope);
}
