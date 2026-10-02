import type { RabiLinkRelayGlobalConfig } from "./globalConfig.js";
import { peerDeviceKind } from "../rabiPeerDiscovery.js";
import { isRabiPcVersionAdvertisement, normalizeRabiPcVersion, rabiPcVersionFromCapabilities } from "../shared/rabiPcVersionContract.js";

const MAX_BODY_BYTES = 256 * 1024;
const DEADLINE_MS = 3_000;

export type RabiLinkHomeDevice = {
  id: string;
  guid: string;
  name: string;
  deviceKind: string;
  online: boolean;
  capabilities: string[];
  rabiPcVersion: string | null;
  isLocal: boolean;
};

type LocalRabiPcIdentity = Readonly<{ deviceGuid: string; rabiPcVersion: string }>;

export class RabiLinkHomeError extends Error {
  constructor(readonly statusCode: number, readonly errorCode: string, message: string) {
    super(message);
  }
}

function invalidResponse(): RabiLinkHomeError {
  return new RabiLinkHomeError(502, "RABILINK_HOME_INVALID_RESPONSE", "RabiLink 返回的数据无效，请稍后重试。");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || value.length > maxLength || (!optional && !value.trim())) throw invalidResponse();
  return value;
}

function device(value: unknown, localDeviceId: string, local?: LocalRabiPcIdentity): RabiLinkHomeDevice {
  const peer = record(value);
  if (typeof peer.online !== "boolean" || !Array.isArray(peer.capabilities) || peer.capabilities.length > 64) throw invalidResponse();
  const id = text(peer.id, 256);
  const guid = text(peer.guid, 256, true);
  const deviceKind = peerDeviceKind(peer.deviceKind);
  const isLocal = Boolean(localDeviceId && local?.deviceGuid && id === localDeviceId && guid === local.deviceGuid);
  const rabiPcVersion = deviceKind !== "pc" ? null : isLocal
    ? normalizeRabiPcVersion(local?.rabiPcVersion) : rabiPcVersionFromCapabilities(peer.capabilities);
  return {
    id,
    guid,
    name: text(peer.name, 256, true),
    deviceKind,
    online: peer.online,
    rabiPcVersion,
    isLocal,
    capabilities: peer.capabilities.filter(value => !isRabiPcVersionAdvertisement(value)).map(value => {
      const capability = text(value, 64);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(capability)) throw invalidResponse();
      return capability;
    })
  };
}

/** Only the saved Manager configuration is accepted; never pass caller headers or URLs. */
export async function readRabiLinkHome(config: Readonly<RabiLinkRelayGlobalConfig>, local?: LocalRabiPcIdentity): Promise<{ devices: RabiLinkHomeDevice[]; checkedAt: string }> {
  if (!config.enabled) throw new RabiLinkHomeError(503, "RABILINK_HOME_DISABLED", "RabiLink 尚未启用。");
  if (!config.url.trim() || !config.token.trim()) throw new RabiLinkHomeError(503, "RABILINK_HOME_NOT_CONFIGURED", "请先保存 RabiLink 服务器地址和应用令牌。");
  let endpoint: URL;
  try {
    const base = new URL(config.url);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    endpoint = new URL(`${base.href.replace(/\/+$/, "")}/api/rabilink/peers`);
  } catch {
    throw new RabiLinkHomeError(503, "RABILINK_HOME_NOT_CONFIGURED", "RabiLink 服务器地址配置无效。");
  }
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const response = await fetch(endpoint, {
      method: "GET", headers: { "x-rabilink-token": config.token, accept: "application/json" },
      redirect: "error", signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RabiLinkHomeError(502, "RABILINK_HOME_UPSTREAM_FAILED", "无法读取 RabiLink 设备，请检查已保存的配置或稍后重试。");
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalidResponse();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new RabiLinkHomeError(502, "RABILINK_HOME_RESPONSE_TOO_LARGE", "RabiLink 返回的数据过大。");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (body.code !== 0 || body.ok !== true || !Array.isArray(body.peers) || body.peers.length > 1000) throw invalidResponse();
    return { devices: body.peers.map(value => device(value, config.deviceId, local)), checkedAt: new Date().toISOString() };
  } catch (error) {
    if (signal.aborted) throw new RabiLinkHomeError(504, "RABILINK_HOME_TIMEOUT", "读取 RabiLink 设备超时，请稍后重试。");
    if (error instanceof RabiLinkHomeError) throw error;
    if (error instanceof SyntaxError) throw invalidResponse();
    throw new RabiLinkHomeError(502, "RABILINK_HOME_UPSTREAM_FAILED", "无法读取 RabiLink 设备，请检查已保存的配置或稍后重试。");
  }
}
