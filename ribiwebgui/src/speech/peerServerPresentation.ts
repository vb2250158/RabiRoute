import type { PeerConnectionStatus } from "../../../src/shared/peerTunnelContract";
export function peerServerDetail(peer: PeerConnectionStatus, now = Date.now()): string {
  if (!peer.online) return "离线";
  if (!peer.supported) return "在线 · 需要升级";
  if (!peer.trusted) return "在线 · 未授权";
  if (peer.state === "connecting") return "在线 · 检测连接中…";
  if (peer.state === "failed") return "在线 · 连接失败";
  if (peer.state !== "connected" || !peer.transport) return "在线 · 待检测";
  const transport = { lan: "局域网直连", p2p: "P2P直连", relay: "服务器中转" }[peer.transport];
  const valid = peer.latencyMs !== null && Number.isFinite(peer.latencyMs) && peer.latencyMs >= 0 && peer.measuredAt !== null && now >= peer.measuredAt && now - peer.measuredAt <= 30_000;
  return "在线 · " + transport + " · " + (valid ? Math.round(peer.latencyMs!) + " ms" : "延迟待检测");
}
