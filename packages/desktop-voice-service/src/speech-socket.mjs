import WebSocket from 'ws';

/** Bounded transport; reject redirects and never propagate URL/header/provider response text. */
export async function openSpeechSocket({ endpoint, headers, signal, handshakeSignalOnly = false, onMessage, onError, WebSocketClass = WebSocket }) {
  signal?.throwIfAborted();
  const socket = new WebSocketClass(endpoint, { headers, followRedirects: false, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 15000 });
  let ready = false, stopping = false, closed = false, closeTask, queued = 0, chain = Promise.resolve();
  let resolveClosed;
  const closure = new Promise(resolve => { resolveClosed = resolve; });
  const failure = () => onError?.(Error('SPEECH_SOCKET_FAILED'));
  socket.on('close', () => { closed = true; signal?.removeEventListener('abort', abort); resolveClosed(); if (ready && !stopping) onError?.(Error('SPEECH_SOCKET_CLOSED')); });
  socket.on('error', () => { if (ready && !stopping) failure(); });
  socket.on('message', (value, binary) => {
    if (stopping || !ready) return;
    if (!binary) { onError?.(Error('SPEECH_BINARY_FRAME_REQUIRED')); return; }
    queued += value.length;
    if (queued > 4 * 1024 * 1024) { onError?.(Error('SPEECH_RECEIVE_BACKLOG')); void close(); return; }
    chain = chain.then(() => { if (!stopping) return onMessage(value); }).catch(error => { if (!stopping) onError?.(error); }).finally(() => { queued -= value.length; });
  });
  function close() {
    if (closeTask) return closeTask;
    stopping = true;
    closeTask = (async () => {
      if (!closed) {
        const timer = setTimeout(() => socket.terminate(), 1500);
        try { socket.close(); await closure; } finally { clearTimeout(timer); }
      }
    })();
    return closeTask;
  }
  function abort() { void close(); }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', () => { ready = true; resolve(); });
      socket.once('error', () => reject(Error('SPEECH_SOCKET_CONNECT_FAILED')));
      socket.once('close', () => reject(Error('SPEECH_SOCKET_CLOSED')));
      socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); reject(Error('SPEECH_PROVIDER_HTTP_' + response.statusCode)); });
    });
    signal?.throwIfAborted();
    if (handshakeSignalOnly) signal?.removeEventListener('abort', abort);
  } catch (error) { await close(); throw error; }
  return {
    async send(bytes) {
      if (stopping || closed || (!handshakeSignalOnly && signal?.aborted)) throw Error('SPEECH_SOCKET_CLOSED');
      if (bytes.length + socket.bufferedAmount > 1024 * 1024) throw Error('SPEECH_SEND_BACKLOG');
      await new Promise((resolve, reject) => socket.send(bytes, { binary: true }, error => error ? reject(Error('SPEECH_SOCKET_SEND_FAILED')) : resolve()));
    }, close,
  };
}
