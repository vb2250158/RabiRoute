export type AndroidDisplayOptions = { serial: string; serverPath: string; adb?: string; ffmpeg?: string; width?: number; height?: number; dpi?: number; signal?: AbortSignal };
export type AndroidDisplayGeometry = Readonly<{ id: number; width: number; height: number; layoutRevision: string }>;
export type AndroidDisplayFrame = { sequence: number; width: number; height: number; data: Buffer; capturedAt: string; display: AndroidDisplayGeometry };
export type AndroidDisplayTouch = { type: "tap"; x: number; y: number } | { type: "swipe"; x: number; y: number; endX: number; endY: number; durationMs: number };
export type AndroidGamepadFrame = { durationMs: number; buttons?: ("A" | "B" | "X" | "Y" | "Up" | "Down" | "Left" | "Right" | "Start" | "Back" | "LB" | "RB" | "LS" | "RS")[];
  leftX?: number; leftY?: number; rightX?: number; rightY?: number; leftTrigger?: number; rightTrigger?: number };
export const ANDROID_DISPLAY_SERVER: Readonly<{ version: string; sha256: string }>;
export class AndroidDisplaySession {
  static open(options: AndroidDisplayOptions): Promise<AndroidDisplaySession>;
  get active(): boolean;
  get gamepadSupported(): boolean;
  get gamepadConnected(): boolean;
  get display(): AndroidDisplayGeometry;
  capture(options?: { after?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<AndroidDisplayFrame>;
  openApp(component: string, options?: { signal?: AbortSignal }): Promise<void>;
  listApps(options?: { signal?: AbortSignal }): Promise<{ appId: string; packageName: string; name: string }[]>;
  touch(action: AndroidDisplayTouch, options?: { signal?: AbortSignal }): Promise<void>;
  gamepadFrame(frame: AndroidGamepadFrame, options?: { signal?: AbortSignal }): Promise<void>;
  neutralGamepad(): Promise<void>;
  closeGamepad(): Promise<void>;
  close(): Promise<void>;
}
