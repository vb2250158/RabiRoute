export type TunnelTransport = "lan" | "p2p" | "relay";
export type PeerConnectionStatus = {
  deviceId: string; name: string; online: boolean; supported: boolean; trusted: boolean;
  state: "idle" | "connecting" | "connected" | "failed" | "offline";
  transport: TunnelTransport | null; latencyMs: number | null; measuredAt: number | null;
  error?: string;
};
export type SpeechServerDirectory = { selectedDeviceId: string; peers: PeerConnectionStatus[] };
