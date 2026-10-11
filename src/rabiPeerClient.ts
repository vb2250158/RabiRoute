import { randomUUID } from "node:crypto";
import { openPeerPacket, sealPeerPacket,
  type PeerPacket, type PeerReply, type PeerRequest } from "./rabiPeerProtocol.js";

export type RabiPeer = { id: string; guid?: string; deviceKind?: string; online: boolean; capabilities: string[]; peerUrls: string[] };
export type PeerCall = { targetDeviceId: string; capability: string; operation: string; input?: unknown };

async function post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal,
  authorize: () => void = () => {}): Promise<PeerPacket> {
  const text = JSON.stringify(body);
  authorize();
  const response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...headers },
    body: text, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) })
    .catch(error => { authorize(); throw error; });
  // Keep response cleanup available even when the request lease expires at fetch completion.
  try { authorize(); } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  if (!response.ok) {
    try { await response.body?.cancel(); } finally { authorize(); }
    throw new Error(`Peer transport HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty peer reply.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      authorize();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 1_500_000) throw new Error("Peer response too large.");
      chunks.push(Buffer.from(result.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally { await reader.cancel().catch(() => {}); authorize(); }
}
export class RabiPeerClient {
  constructor(private readonly options: {
    relay(): { url: string; token: string };
  }) {}
  /** Signalling only: one authenticated exchange, never replay a tunnel allocation across routes. */
  async signal(call: PeerCall, signal?: AbortSignal): Promise<unknown> {
    if (call.capability !== "transport" || call.operation !== "tunnel") throw new Error("Invalid signalling operation.");
    const relay = this.options.relay();
    const authorize = () => {
      const current = this.options.relay();
      if (signal?.aborted) throw new Error("Tunnel signalling cancelled.");
      if (current.url !== relay.url || current.token !== relay.token) throw new Error("Tunnel signalling authority changed.");
    };
    authorize();
    const url = relay.url.replace(/\/+$/, "") + "/api/rabilink/peer/proxy";
    let expectedInstance: string | undefined;
    const exchange = async (request: PeerRequest) => {
      const packet = await post(url, { targetDeviceId: call.targetDeviceId, packet: sealPeerPacket(request, relay.token) }, { "x-rabilink-token": relay.token }, 5_000, signal, authorize);
      const reply = openPeerPacket<PeerReply>(packet, relay.token);
      if (reply.requestId !== request.requestId || reply.identity?.deviceId !== call.targetDeviceId || !reply.identity.generation || !reply.identity.instanceId || request.generation && reply.identity.generation !== request.generation || expectedInstance && reply.identity.instanceId !== expectedInstance || !reply.ok) throw new Error(reply.error || "Tunnel signalling rejected.");
      return reply;
    };
    const base = { targetDeviceId: call.targetDeviceId, expiresAt: Date.now() + 60_000 };
    const described = await exchange({ ...base, requestId: randomUUID(), capability: "system", operation: "describe", input: {} });
    expectedInstance = described.identity.instanceId;
    return (await exchange({ ...base, requestId: randomUUID(), generation: described.identity.generation,
      capability: call.capability, operation: call.operation, input: call.input })).data;
  }
}
