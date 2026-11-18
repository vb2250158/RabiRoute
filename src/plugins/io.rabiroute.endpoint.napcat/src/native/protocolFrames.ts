import { NapcatApiError } from "../manager/napcatApiTransport.js";
/** Installed Native HTTP streams use JSON envelopes delimited by a blank line, rather than SSE wire text. */
export function openNapcatProtocolFrames(response: Response, signal: AbortSignal, maxFrameBytes: number) {
    if (response.status !== 200 || !response.body) {
        void response.body?.cancel().catch(() => {
        });
        throw new NapcatApiError(503, "QQ_NATIVE_STREAM_HTTP_REJECTED");
    }
    const reader = response.body.getReader();
    let cancellation: Promise<void> | undefined;
    const cancel = () => cancellation ??= reader.cancel().catch(() => {
    });
    const abort = () => {
        void cancel();
    };
    signal.addEventListener("abort", abort, { once: true });
    const parse = (text: string): Record<string, unknown> => {
        if (Buffer.byteLength(text) > maxFrameBytes)
            throw new NapcatApiError(413, "QQ_NATIVE_STREAM_FRAME_TOO_LARGE");
        let envelope: {
            status?: unknown;
            retcode?: unknown;
            data?: unknown;
        };
        try {
            envelope = JSON.parse(text);
        }
        catch {
            throw new NapcatApiError(503, "QQ_NATIVE_STREAM_INVALID");
        }
        if (envelope?.status !== "ok" || envelope.retcode !== 0)
            throw new NapcatApiError(503, "QQ_NATIVE_STREAM_REJECTED");
        if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data))
            throw new NapcatApiError(503, "QQ_NATIVE_STREAM_INVALID");
        return envelope.data as Record<string, unknown>;
    };
    return { cancel, frames: (async function* () {
            const decoder = new TextDecoder("utf8", { fatal: true });
            let pending = "";
            try {
                while (true) {
                    signal.throwIfAborted();
                    const next = await reader.read();
                    signal.throwIfAborted();
                    try {
                        pending += decoder.decode(next.value, { stream: !next.done });
                    }
                    catch {
                        throw new NapcatApiError(503, "QQ_NATIVE_STREAM_INVALID");
                    }
                    let separator: RegExpExecArray | null;
                    while ((separator = /\r?\n\r?\n/.exec(pending))) {
                        const text = pending.slice(0, separator.index).trim();
                        pending = pending.slice(separator.index + separator[0].length);
                        if (text)
                            yield parse(text);
                    }
                    if (Buffer.byteLength(pending) > maxFrameBytes)
                        throw new NapcatApiError(413, "QQ_NATIVE_STREAM_FRAME_TOO_LARGE");
                    if (next.done)
                        break;
                }
                if (pending.trim())
                    yield parse(pending.trim());
            }
            finally {
                signal.removeEventListener("abort", abort);
                await cancel();
                reader.releaseLock();
            }
        })() };
}
