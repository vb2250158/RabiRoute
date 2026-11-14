export interface AudioDevice { id: string; kind: 'audioinput' | 'audiooutput'; label: string }
export interface CaptionSettings {
  enabled?: boolean; locked?: boolean; skin?: 'light' | 'dark'; fontSize?: number; opacity?: number; position?: 'top' | 'bottom';
  bounds?: { x: number; y: number; width: number; height: number } | null;
}
export interface DesktopRecording {
  start(onError?: (error: Error) => unknown, options?: { onPcm?(pcm16le: Uint8Array): unknown }): Promise<void>;
  amplitude(): number;
  markSpeech(): void;
  take(): Promise<Uint8Array>;
  /** Extracts the current segment; use dispose to release the microphone. */
  stop(): Promise<Uint8Array>;
  dispose(): Promise<unknown>;
}
export interface DesktopDevice {
  pid: number;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
  enumerateDevices(): Promise<AudioDevice[]>;
  configurePresenter(settings: CaptionSettings): Promise<unknown>;
  present(value: { text?: string; statusText?: string; outputEnabled?: boolean; capturePaused?: boolean }): Promise<unknown>;
  createRecording(): DesktopRecording;
  createPlayer(bytes: Uint8Array): Promise<{ events: EventTarget; play(): Promise<unknown>; stop(): Promise<unknown>; destroy(): Promise<unknown> }>;
  createStreamPlayer(options?: { sampleRate?: number }): Promise<{
    events: EventTarget; append(pcm16le: Uint8Array): Promise<unknown>; finish(): Promise<unknown>;
    play(): Promise<unknown>; stop(): Promise<unknown>; destroy(): Promise<unknown>;
  }>;
}
export function openDesktopDevice(options: {
  electronExecutable: string; runtimeEntry?: string; signal?: AbortSignal; inputDeviceId?: string; outputDeviceId?: string;
  maxDurationMs?: number; onEvent?: (event: Record<string, unknown>) => unknown; startTimeoutMs?: number;
}): Promise<DesktopDevice>;
