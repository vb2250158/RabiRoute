import type { SpeechSynthesisCommand, SpeechPlaybackStatus } from "@shared/speechControlContract";
import type { SynthesisOptions } from "../../../../../packages/assistant-runtime/src/aiui-runtime.js";

type PlaybackSnapshot = { jobs?: readonly Record<string, unknown>[] };
type PlaybackClient = {
  synthesize(command: SpeechSynthesisCommand): Promise<{ playbackJob?: string }>;
  cancelPlaybackSession(sessionId: string): Promise<SpeechPlaybackStatus>;
};
type Options = {
  client: PlaybackClient;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
  voice: string;
  model: string;
  routeId: string;
  speed?: number;
  language?: string;
  instructions?: string;
  createId?: () => string;
  onError(error: unknown): void;
};

/** Adapts the host FIFO to shared voice playback. It neither plays browser audio nor owns an assistant turn. */
export function createAssistantPlayback(options: Options) {
  if (!options.voice || !options.model || !options.routeId) throw new Error("ASSISTANT_VOICE_SELECTION_REQUIRED");
  const active = new Set<() => Promise<unknown>>();
  const cancellations = new Set<Promise<unknown>>();
  let closed = false;
  return Object.freeze({
    adapterId: "rabi.host-playback",
    supportsSynthesize: true,
    async synthesize(text: string, { signal }: SynthesisOptions = {}) {
      if (closed || signal?.aborted) throw new Error("ASSISTANT_PLAYBACK_CLOSED");
      // cancel-session fences this id for late synthesis. Never reuse it for a later sentence.
      const sessionId = `assistant.${(options.createId ?? (() => crypto.randomUUID()))()}`;
      let dispatched = false, retired = false, stopped = false, terminal = false;
      let jobId: string | undefined;
      let cancelPromise: Promise<unknown> | undefined;
      let onEnded: (() => void) | undefined, onError: ((error: unknown) => void) | undefined;
      const detach = () => {
        if (retired) return;
        retired = true;
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        active.delete(stop);
        onEnded = undefined;
        onError = undefined;
      };
      const stop = (): Promise<unknown> => {
        stopped = true;
        detach();
        if (!dispatched || terminal) return Promise.resolve();
        if (!cancelPromise) {
          const request = Promise.resolve().then(() => options.client.cancelPlaybackSession(sessionId)).catch(error => {
            options.onError(error);
            throw error;
          });
          cancelPromise = request;
          cancellations.add(request);
          void request.then(() => cancellations.delete(request), () => cancellations.delete(request));
        }
        return cancelPromise;
      };
      const abort = () => { void stop().catch(() => {}); };
      const fail = (error: unknown) => {
        if (retired || stopped || terminal) return;
        const callback = onError;
        // If the shared owner has already detached, the local adapter still cancels its job.
        void stop().catch(() => {});
        callback?.(error);
      };
      const unsubscribe = options.subscribe(snapshot => {
        if (retired || !dispatched || stopped || terminal) return;
        const job = snapshot.jobs?.find(value => (value.sessionId ?? value.session_id) === sessionId);
        if (!job || (jobId && job.id !== jobId)) return;
        if (job.status === "done") {
          terminal = true;
          const callback = onEnded;
          detach();
          callback?.();
        } else if (job.status === "error" || job.status === "cancelled") {
          terminal = true;
          const callback = onError;
          detach();
          callback?.(new Error(String(job.error || `ASSISTANT_PLAYBACK_${job.status}`)));
        }
      });
      active.add(stop);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      return {
        task: { abort: stop },
        player: {
          audioPlayer: {
            onEnded(callback: () => void) { onEnded = callback; },
            onError(callback: (error: unknown) => void) { onError = callback; }
          },
          play() {
            if (dispatched || retired || stopped) return;
            dispatched = true;
            return options.client.synthesize({ input: text, voice: options.voice, model: options.model,
              responseFormat: "wav", speed: options.speed ?? 1, language: options.language ?? null,
              instructions: options.instructions ?? null,
              play: true, sessionId, routeId: options.routeId }).then(receipt => {
              if (retired) return;
              if (!receipt.playbackJob) throw new Error("ASSISTANT_PLAYBACK_RECEIPT_MISSING");
              jobId = receipt.playbackJob;
              // HTTP acceptance is not playback completion. Only the native job event retires output.
            }).catch(fail);
          },
          stop,
          destroy: detach
        }
      };
    },
    async dispose() {
      closed = true;
      const stops = [...active].map(stop => stop());
      const results = await Promise.allSettled([...new Set([...stops, ...cancellations])]);
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "ASSISTANT_PLAYBACK_CLEANUP_FAILED");
    }
  });
}
