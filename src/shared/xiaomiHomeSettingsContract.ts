import type { HomeSpeechBinding } from "./homeMediaContract.js";

export type XiaomiHomeEventDeliveryMode = "significant" | "all";

export type XiaomiHomeRuntimeSettings = Readonly<{
  baseUrl: string;
  requestTimeoutMs: number;
  /** @deprecated Always true since 0.3.22; remove compatibility projection in 0.4.0. */
  writeEnabled: boolean;
  speechBindings: readonly HomeSpeechBinding[];
  allowPublicBaseUrl: boolean;
  allowInsecurePrivateHttp: boolean;
  agentRoleId: string;
  eventMonitorEnabled: boolean;
  eventDeliveryMode: XiaomiHomeEventDeliveryMode;
  cameraMotionEntityIds: readonly string[];
  cameraClipCaptureEnabled: boolean;
  cameraClipAllowedHosts: readonly string[];
  ffmpegPath: string;
  ffprobePath: string;
  /** @deprecated Ignored since 0.3.22; remove compatibility projection in 0.4.0. */
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
