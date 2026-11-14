/** Adapter-owned, synchronous identity check. Never yield between check and dispatch. */
export function checkCurrent(assertCurrent) {
  if (assertCurrent === undefined) return;
  if (typeof assertCurrent !== 'function') throw new TypeError('ASSISTANT_BINDING_CHECK_INVALID');
  const result = assertCurrent();
  if (result !== undefined) {
    // Reject async guards, including their later rejection, without leaking an unhandled Promise.
    if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
    throw Object.assign(new Error('ASSISTANT_BINDING_CHECK_MUST_BE_SYNC'), { code: 'ASSISTANT_BINDING_CHECK_MUST_BE_SYNC' });
  }
}
