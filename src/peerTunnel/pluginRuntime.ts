/** Owns one prepared Peer instance; only the kernel publication observer may publish it. */
export function createPeerRuntimeOwner(options: {
  publish(): void;
  rollback(): void;
  unpublish(): void;
  stopAccepting(): void;
  stop(): void | Promise<void>;
}) {
  let published = false;
  let stopping = false;
  let retirement: Promise<void> | undefined;
  const stopAccepting = () => {
    if (stopping) return;
    stopping = true;
    options.stopAccepting();
  };
  return Object.freeze({
    publish() {
      if (stopping) throw new Error("Peer runtime is stopping.");
      if (published) return;
      published = true;
      options.publish();
    },
    rollback() {
      if (!published || stopping) return;
      options.rollback();
      published = false;
    },
    stopAccepting,
    stop(): Promise<void> {
      if (retirement) return retirement;
      let resolve!: () => void, reject!: (error: unknown) => void;
      retirement = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      const errors: unknown[] = [];
      try { stopAccepting(); } catch (error) { errors.push(error); }
      // Only the Manager owns the identity-guarded active pointer. A failed
      // pointer cleanup must not skip closing this runtime's actual resources.
      try { if (published) options.unpublish(); } catch (error) { errors.push(error); }
      void Promise.resolve().then(async () => {
        try { await options.stop(); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Peer runtime cleanup failed.");
      }).then(resolve, reject);
      return retirement;
    }
  });
}
