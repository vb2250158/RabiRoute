/** OpenAI-compatible model port for the shared assistant loop; no browser-owned keys. */
export function createChatModel({ endpoint, model, initialPrompts = [], resolveCredential,
  fetcher = fetch, signal, timeoutMs = 60000 }) {
  const address = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  if (address.username || address.password || address.search || address.hash ||
      (address.protocol !== 'https:' && !(local && address.protocol === 'http:'))) throw Error('ASSISTANT_MODEL_ENDPOINT_INVALID');
  if (typeof model !== 'string' || !model.trim()) throw Error('ASSISTANT_MODEL_REQUIRED');
  const lifetime = new AbortController();
  let history = [], busy = false;
  return {
    async promptStreaming(input) {
      if (busy) throw Error('ASSISTANT_MODEL_BUSY');
      busy = true;
      const requestSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
      let reader;
      try {
        requestSignal.throwIfAborted();
        const key = await resolveCredential(address.href);
        if (address.hostname === 'api.openai.com' && key?.startsWith('ck_')) throw Error('MODEL_CREDENTIAL_PROVIDER_MISMATCH');
        const messages = [...initialPrompts, ...history, ...input];
        const response = await fetcher(address.href, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify({ model, messages, stream: true }),
        });
        if (!response.ok) throw Error('ASSISTANT_MODEL_HTTP_' + response.status);
        if (!response.body) throw Error('ASSISTANT_MODEL_EMPTY');
        reader = response.body.getReader();
      } catch (error) { busy = false; throw error; }
      let pending = '', text = '', ended = false;
      const decoder = new TextDecoder();
      const chunks = [];
      const finish = async (confirmed) => {
        if (ended) return;
        ended = true;
        try { await reader.cancel(); } finally { reader.releaseLock(); busy = false; }
        if (confirmed) {
          history.push(...input, { role: 'assistant', content: text });
          while (history.length > 24 || history.reduce((n, item) => n + item.content.length, 0) > 64000) history.shift();
        }
      };
      return {
        async read() {
          try {
            for (;;) {
              requestSignal.throwIfAborted();
              if (chunks.length) return { done: false, value: chunks.shift() };
              if (ended) return { done: true };
              const separator = pending.search(/\r?\n\r?\n/);
              if (separator >= 0) {
                const frame = pending.slice(0, separator);
                pending = pending.slice(separator).replace(/^\r?\n\r?\n/, '');
                const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!data) continue;
                if (data === '[DONE]') { await finish(true); continue; }
                let value;
                try { value = JSON.parse(data); } catch { throw Error('ASSISTANT_MODEL_RESPONSE_INVALID'); }
                if (value.error) throw Error('ASSISTANT_MODEL_PROVIDER_ERROR');
                const delta = value.choices?.[0]?.delta?.content;
                if (typeof delta === 'string' && delta) {
                  text += delta;
                  if (text.length > 128000) throw Error('ASSISTANT_MODEL_RESPONSE_LIMIT');
                  chunks.push(delta);
                }
                continue;
              }
              const next = await reader.read();
              if (next.done) throw Error('ASSISTANT_MODEL_STREAM_INCOMPLETE');
              pending += decoder.decode(next.value, { stream: true });
              if (pending.length > 256000) throw Error('ASSISTANT_MODEL_RESPONSE_LIMIT');
            }
          } catch (error) { await finish(false); throw error; }
        },
        cancel: () => finish(false),
      };
    },
    destroy() { lifetime.abort(); history = []; },
  };
}
