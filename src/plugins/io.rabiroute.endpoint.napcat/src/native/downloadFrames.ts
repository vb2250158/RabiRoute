import { openNapcatProtocolFrames } from "./protocolFrames.js";
import { NapcatApiError } from "../manager/napcatApiTransport.js";
export type NativeDownloadFrame = {
    type: "stream";
    data_type: "file_info";
    file_name: string;
    file_size: number;
    chunk_size: number;
    width?: number;
    height?: number;
    out_format?: string;
} | {
    type: "stream";
    data_type: "file_chunk";
    index: number;
    data: string;
    size: number;
} | {
    type: "response";
    data_type: "file_complete";
    total_chunks: number;
    total_bytes: number;
};
type Options = {
    signal: AbortSignal;
    chunkBytes: number;
    maxBytes: number;
    maxFrameBytes: number;
    name: string;
    outFormat?: string;
    allowConvertedSize?: boolean;
};
const invalid = () => new NapcatApiError(503, "QQ_NATIVE_STREAM_INVALID");
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** Parse the installed HTTP CRLF-delimited native protocol. Completion is withheld until native EOF and byte/chunk verification. */
export function openNativeDownloadFrames(response: Response, options: Options) {
    const native = openNapcatProtocolFrames(response, options.signal, options.maxFrameBytes);
    const cancel = native.cancel;
    const frames = (async function* (): AsyncGenerator<NativeDownloadFrame> {
        let info = false, announcedBytes = 0, chunks = 0, bytes = 0;
        let completion: Extract<NativeDownloadFrame, {
            type: "response";
        }> | undefined;
        function parse(value: Record<string, unknown>): NativeDownloadFrame {
            if (completion)
                throw invalid();
            if (value.type === "stream" && value.data_type === "file_info") {
                if (info || chunks || !nonnegative(value.file_size) || value.chunk_size !== options.chunkBytes)
                    throw invalid();
                info = true;
                announcedBytes = value.file_size;
                if (!options.allowConvertedSize && announcedBytes > options.maxBytes)
                    throw new NapcatApiError(413, "QQ_NATIVE_STREAM_TOO_LARGE");
                const result: Extract<NativeDownloadFrame, {
                    data_type: "file_info";
                }> = {
                    type: "stream", data_type: "file_info", file_name: Buffer.from(options.name, "utf8").toString("utf8"),
                    file_size: value.file_size, chunk_size: options.chunkBytes
                };
                for (const key of ["width", "height"] as const)
                    if (value[key] !== undefined) {
                        if (!nonnegative(value[key]))
                            throw invalid();
                        result[key] = value[key];
                    }
                if (options.outFormat)
                    result.out_format = options.outFormat;
                return result;
            }
            if (!info)
                throw invalid();
            if (value.type === "stream" && value.data_type === "file_chunk") {
                if (value.index !== chunks || !nonnegative(value.size) || value.size < 1 || value.size > options.chunkBytes
                    || typeof value.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))
                    throw invalid();
                const chunk = Buffer.from(value.data, "base64");
                if (chunk.length !== value.size || chunk.toString("base64") !== value.data)
                    throw invalid();
                bytes += chunk.length;
                if (bytes > options.maxBytes)
                    throw new NapcatApiError(413, "QQ_NATIVE_STREAM_TOO_LARGE");
                return { type: "stream", data_type: "file_chunk", index: chunks++, data: value.data, size: value.size };
            }
            if (value.type === "response" && value.data_type === "file_complete" && value.total_chunks === chunks && value.total_bytes === bytes
                && (options.allowConvertedSize || bytes === announcedBytes)) {
                completion = { type: "response", data_type: "file_complete", total_chunks: chunks, total_bytes: bytes };
                return completion;
            }
            throw invalid();
        }
        try {
            for await (const value of native.frames) {
                const frame = parse(value);
                if (frame.type !== "response")
                    yield frame;
            }
            if (!completion)
                throw new NapcatApiError(503, "QQ_NATIVE_STREAM_INCOMPLETE");
            yield completion;
        }
        finally {
            await cancel();
        }
    })();
    return { frames, cancel };
}
