import type { ApiOperationInput, ApiOperationResult } from "./apiOperationContract.js";
import type { AndroidDisplayTarget, DeviceComputerPort } from "../plugins/io.rabiroute.manager.route-control/src/manager/deviceControlOperations.js";

type Port = NonNullable<DeviceComputerPort["androidDisplays"]>;
type BridgePeer = { deviceId: string; name: string; online: boolean };
type RemoteReply = { status: number; body: Record<string, unknown> };
type Transport = {
  localDeviceId(): string;
  peers(): Promise<BridgePeer[]>;
  request(ownerDeviceId: string, method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal,
    source?: { request: ApiOperationInput["request"]; label?: string }): Promise<RemoteReply>;
};

const localDirectory = "/api/device-control/targets?kind=android-display&location=local";
const execution = "/api/device-control/execute";
const headers = { "cache-control": "no-store" };
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function localTarget(value: unknown): AndroidDisplayTarget | undefined {
  const target = record(value);
  if (target?.kind !== "android-display" || typeof target.bridgeId !== "string" || !target.bridgeId ||
    target.ownerDeviceId !== undefined || (target.surfaceId !== undefined && (typeof target.surfaceId !== "string" || !target.surfaceId))) return undefined;
  return { kind: "android-display", bridgeId: target.bridgeId, ...(target.surfaceId ? { surfaceId: target.surfaceId } : {}) };
}
function error(status: number, errorCode: string, message: string): ApiOperationResult {
  return { status, headers, body: { code: -1, errorCode, message } };
}

/** Routes peer-owned displays over the original Manager connection. The peer still owns every receipt and display. */
export function createAndroidDisplayRouting(local: Port, transport: Transport): Port {
  async function readPeers(signal?: AbortSignal) {
    let peers: BridgePeer[];
    try { peers = await transport.peers(); }
    catch { return { targets: [], sourceErrors: [{ source: "android-display", message: "Unable to read the Android bridge peer directory." }] }; }
    const self = transport.localDeviceId();
    const sourceErrors: { source: string; ownerDeviceId: string; message: string }[] = [];
    const snapshots = await Promise.all(peers.filter(peer => peer.online && peer.deviceId !== self).map(async peer => {
      try {
        const reply = await transport.request(peer.deviceId, "GET", localDirectory, undefined, signal);
        if (reply.status === 404) return []; // The peer predates Android display support.
        const data = record(reply.body.data);
        if (reply.status !== 200 || reply.body.code !== 0 || !Array.isArray(data?.targets)) throw new Error("Incomplete Android bridge directory.");
        if (Array.isArray(data.sourceErrors) && data.sourceErrors.length) sourceErrors.push({
          source: "android-display", ownerDeviceId: peer.deviceId, message: "The Android bridge owner reported a partial directory."
        });
        return data.targets.flatMap(value => {
          const row = record(value);
          const target = localTarget(row?.target);
          if (!target || typeof row?.name !== "string" || typeof row.online !== "boolean" ||
            !Array.isArray(row.capabilities) || !row.capabilities.every(item => typeof item === "string")) return [];
          return [{ name: peer.name ? peer.name + " · " + row.name : row.name, online: row.online,
            capabilities: row.capabilities, target: { ...target, ownerDeviceId: peer.deviceId } }];
        });
      } catch {
        sourceErrors.push({ source: "android-display", ownerDeviceId: peer.deviceId, message: "Unable to read the remote Android display owner." });
        return [];
      }
    }));
    signal?.throwIfAborted();
    return { targets: snapshots.flat(), sourceErrors };
  }

  return {
    async list(signal, ownedOnly) {
      if (ownedOnly) return local.list(signal, true);
      const [owned, remote] = await Promise.all([local.list(signal, true), readPeers(signal)]);
      return { targets: [...owned.targets, ...remote.targets], sourceErrors: [...owned.sourceErrors, ...remote.sourceErrors] };
    },
    async execute(target, body, label, signal, request) {
      const { ownerDeviceId, ...original } = target;
      if (!ownerDeviceId) return local.execute(original, body, label, signal, request);
      if (ownerDeviceId === transport.localDeviceId()) return error(409, "ANDROID_DISPLAY_OWNER_CHANGED", "Refresh the directory and pick the original local Android target.");
      try {
        const reply = await transport.request(ownerDeviceId, "POST", execution, { ...body, target: original }, signal,
          request && { request, label });
        const data = record(reply.body.data);
        if (reply.status >= 200 && reply.status < 300 && (body.action === "display.open" || body.action === "display.close")) {
          const returned = localTarget(data?.target);
          if (!returned || returned.bridgeId !== original.bridgeId || !returned.surfaceId ||
            (original.surfaceId && returned.surfaceId !== original.surfaceId)) throw new Error("Android display owner returned a different target.");
          return { status: reply.status, headers, body: { ...reply.body, data: { ...data, target: { ...returned, ownerDeviceId } } } };
        }
        return { status: reply.status, headers, body: reply.body };
      } catch {
        signal?.throwIfAborted();
        return error(502, "ANDROID_DISPLAY_PEER_OUTCOME_UNCONFIRMED", "The remote response is unavailable. Read the original display or request before repeating an action.");
      }
    }
  };
}
