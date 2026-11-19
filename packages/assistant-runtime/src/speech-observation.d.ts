/** Actual recognition outputs for one utterance, not user-stated identity facts. */
export interface SpeechObservation {
 readonly source: 'speech-recognition';
 readonly provider?: string;
 readonly model?: string;
 readonly estimates: Readonly<Record<string, string | number | boolean>>;
}
export function snapshotSpeechObservation(value: SpeechObservation | undefined): SpeechObservation | undefined;

export type RecentSpeech = readonly {text: string; ageMs: number}[];
export function snapshotRecentSpeech(value: RecentSpeech | undefined): RecentSpeech | undefined;
