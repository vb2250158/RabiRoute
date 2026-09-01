export type XiaomiHomeEventDeliveryMode = "significant" | "all";

export type XiaomiHomeRuntimeSettings = Readonly<{
  baseUrl: string;
  tokenEnv: string;
  requestTimeoutMs: number;
  writeEnabled: boolean;
  allowPublicBaseUrl: boolean;
  agentRoleId: string;
  eventMonitorEnabled: boolean;
  eventDeliveryMode: XiaomiHomeEventDeliveryMode;
  cameraMotionEntityIds: readonly string[];
  cameraClipCaptureEnabled: boolean;
  cameraClipAllowedHosts: readonly string[];
  ffmpegPath: string;
  ffprobePath: string;
  artifactReadTokenEnv: string;
  cameraClipRequestTimeoutMs: number;
  cameraClipMaxSegments: number;
  cameraClipMaxSegmentBytes: number;
}>;

export type XiaomiHomeSettingsSnapshot = Readonly<{
  schemaVersion: 1;
  source: "profile" | "runtime";
  revision: string;
  settings: XiaomiHomeRuntimeSettings;
}>;

export type XiaomiHomeSettingsUpdate = Readonly<{
  revision: string;
  settings: XiaomiHomeRuntimeSettings;
}>;
