export type SpeechAuthorityGuard = () => void;

/** Preserve the first denial even if the underlying policy later recovers. */
export function stickySpeechAuthority(guard?: SpeechAuthorityGuard): SpeechAuthorityGuard {
  let denied = false;
  let rejection: unknown;
  return () => {
    if (denied) throw rejection;
    try { guard?.(); } catch (error) {
      denied = true;
      rejection = error;
      throw error;
    }
  };
}

/** Check actual dispatch and both asynchronous completion paths. */
export async function awaitSpeechAuthority<T>(guard: SpeechAuthorityGuard | undefined, operation: () => Promise<T>): Promise<T> {
  guard?.();
  try {
    const result = await operation();
    guard?.();
    return result;
  } catch (error) {
    guard?.();
    throw error;
  }
}
