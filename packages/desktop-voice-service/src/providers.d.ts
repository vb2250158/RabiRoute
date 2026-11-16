export interface HttpSpeechConfig { endpoint: string; model: string; credentialRef?: string }
export type SpeechExpression = Record<string,string|number>;
export type TranscriptionParameters = Record<string,string|number|boolean|(string|number)[]>;
export function createHttpSpeechProviders(options: {
  asr?: HttpSpeechConfig & { encode?(): TranscriptionParameters };
  tts?: HttpSpeechConfig & { voice: string; encode?(expression?: SpeechExpression): Record<string,unknown> };
  resolveCredential(ref: string): Promise<string | undefined>; fetcher?: typeof fetch; timeoutMs?: number;
}): {
  recognize(audio: Uint8Array, signal: AbortSignal): Promise<{ text: string; [key:string]:unknown }>;
  synthesize(text: string, signal: AbortSignal, expression?: SpeechExpression, trace?: {onRequest?(event:Record<string,unknown>):unknown}): Promise<Uint8Array>;
};
