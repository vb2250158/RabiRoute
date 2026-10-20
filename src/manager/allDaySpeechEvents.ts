import { localSpeechEndpoint } from "../speech/localSpeechClient.js";

/** A recording lease owns this subscription. Retries reconnect, never poll history. */
export function watchAllDaySpeechEvents(url: () => string, changed: (id?: string) => void, failed: (error: string) => void): () => void {
  const abort = new AbortController();
  let retry: NodeJS.Timeout | undefined;
  async function connect() {
    try {
      const response = await fetch(localSpeechEndpoint(url(), "/v1/events"), { signal: abort.signal, headers: { accept: "text/event-stream" } });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Speech record events are unavailable");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", kind = "", data = "";
      try {
        while (!abort.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length + data.length > 65536) throw new Error("Speech event exceeds the metadata limit");
          for (let index; (index = buffer.indexOf("\n")) >= 0;) {
            const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
            if (!line) {
              if (!abort.signal.aborted && kind === "ready") changed();
              if (!abort.signal.aborted && kind === "records_changed") {
                const value = JSON.parse(data);
                if (value.kind === "asr" && typeof value.id === "string" && value.id.length <= 200) changed(value.id);
              }
              kind = ""; data = "";
            } else if (line.startsWith("event:")) kind = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trimStart();
          }
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!abort.signal.aborted) throw new Error("Speech record event connection closed");
    } catch (error) {
      if (abort.signal.aborted) return;
      failed(error instanceof Error ? error.message : String(error));
      retry = setTimeout(() => { void connect(); }, 3000); retry.unref();
    }
  }
  void connect();
  return () => { clearTimeout(retry); abort.abort(); };
}
