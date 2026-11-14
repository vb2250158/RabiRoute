export interface HttpSpeechConfig { endpoint: string; model: string; credentialRef?: string }
export function createHttpSpeechProviders(options: {
  asr?: HttpSpeechConfig; tts?: HttpSpeechConfig & { voice: string };
  resolveCredential(ref: string): Promise<string | undefined>; fetcher?: typeof fetch; timeoutMs?: number;
}): {
  recognize(audio: Uint8Array, signal: AbortSignal): Promise<{ text: string }>;
  synthesize(text: string, signal: AbortSignal): Promise<Uint8Array>;
};
