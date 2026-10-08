/** Bound the complete read, including response bodies, without retrying capture mutations. */
export async function readAllDayResource<T>(url: string, read: (response: Response) => Promise<T>, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = 12000): Promise<T> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const response = await fetch(url, { ...init, signal: combined });
    return await read(response);
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) {
      throw new DOMException("Recording request timed out", "TimeoutError");
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
