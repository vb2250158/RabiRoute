// The viewer receives only a GUID, current LAN candidates and the shared transport order.
// The document key stays in the URL fragment and WebCrypto; Relay never receives it.
const id = location.pathname.split('/').filter(Boolean).at(-1);
const status = document.querySelector('#status');
const frame = document.querySelector('iframe');
try {
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const key = await crypto.subtle.importKey('raw', decode(location.hash.slice(1)), 'AES-GCM', false, ['decrypt']);
history.replaceState(null, '', location.pathname + location.hash);
const CONNECTION_TIMEOUT_MS = 10000;
async function withinConnectionBudget(work, message = '连接超时') {
  const attempt = new AbortController();
  let deadline;
  const expired = new Promise((_, reject) => {
    deadline = setTimeout(() => { const error = new Error(message); attempt.abort(error); reject(error); }, CONNECTION_TIMEOUT_MS);
  });
  try { return await Promise.race([work(attempt.signal), expired]); }
  finally { clearTimeout(deadline); attempt.abort(); }
}
const metadata = await withinConnectionBudget(async signal => {
  const response = await fetch(location.pathname + '/connection', { cache: 'no-store', signal });
  signal.throwIfAborted();
  if (!response.ok) throw new Error('分享不存在或电脑离线。');
  return response.json();
});
const session = crypto.randomUUID();
const offer = async (value, signal) => {
  const response = await fetch(location.pathname + '/offer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal });
  signal.throwIfAborted();
  if (!response.ok) throw new Error('电脑握手失败 (' + response.status + ')');
  return response.json();
};
function messages(channel) {
  const queued = []; let wake; let failure;
  channel.addEventListener('message', event => { queued.push(event.data); wake?.(); });
  channel.addEventListener('close', () => { failure = new Error('连接已关闭'); wake?.(); });
  channel.addEventListener('error', () => { failure = new Error('连接失败'); wake?.(); });
  return async () => {
    while (!queued.length) {
      if (failure) throw failure;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { wake = undefined; reject(new Error('读取超时')); }, 30000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    const value = queued.shift();
    return JSON.parse(typeof value === 'string' ? value : value instanceof Blob ? await value.text() : new TextDecoder().decode(value));
  };
}
function openSocket(url) {
  const socket = new WebSocket(url), next = messages(socket);
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('连接超时')); }, 2000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); }, { once: true });
  });
  return { socket, next, opened };
}
async function read(channel, next) {
  const header = await next(), chunks = []; let offset = 0, sequence = 0;
  do {
    channel.send('next');
    const packet = await next();
    if (packet.aad !== `${id}:${sequence++}:${offset}:${header.bytes}`) throw new Error('图片/文档传输顺序不符');
    const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(packet.nonce), additionalData: new TextEncoder().encode(packet.aad) }, key, decode(packet.data)));
    chunks.push(decrypted); offset += decrypted.length;
    if (offset > header.bytes) throw new Error('文档长度不符');
  } while (offset < header.bytes);
  channel.send('done');
  document.title = header.name;
  frame.src = URL.createObjectURL(new Blob(chunks, { type: 'text/html;charset=utf-8' }));
  frame.hidden = false;
}
async function connect(transport) {
  if (transport === 'lan') {
    for (const candidate of metadata.peerUrls) {
      const url = new URL(candidate); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = `/html-shares/${id}/socket`; url.search = '';
      const connection = openSocket(url);
      try { await connection.opened; await read(connection.socket, connection.next); return; }
      catch { /* Try the next current LAN candidate before the next transport. */ }
      finally { connection.socket.close(); }
    }
    throw new Error('局域网不可达');
  }
  if (transport === 'p2p') {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const channel = peer.createDataChannel('rabi.tunnel.v1', { ordered: true }), next = messages(channel);
    try {
      await withinConnectionBudget(async signal => {
        const opened = new Promise((resolve, reject) => {
          channel.addEventListener('open', resolve, { once: true });
          channel.addEventListener('error', () => reject(new Error('P2P连接失败')), { once: true });
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        void opened.catch(() => {});
        const description = await peer.createOffer();
        signal.throwIfAborted();
        await peer.setLocalDescription(description);
        signal.throwIfAborted();
        if (peer.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            peer.removeEventListener('icegatheringstatechange', changed);
            signal.removeEventListener('abort', finish);
            if (signal.aborted) reject(signal.reason); else resolve();
          };
          const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
          const timer = setTimeout(finish, 3000);
          peer.addEventListener('icegatheringstatechange', changed);
          signal.addEventListener('abort', finish, { once: true });
        });
        signal.throwIfAborted();
        const answer = await offer({ kind: 'p2p', sdp: peer.localDescription.sdp }, signal);
        signal.throwIfAborted();
        await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
        signal.throwIfAborted();
        await opened;
      }, 'P2P连接超时');
      await read(channel, next);
    } finally { peer.close(); }
    return;
  }
  const url = new URL(location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname += '/socket'; url.search = new URLSearchParams({ room: session, side: 'viewer' }).toString(); url.hash = '';
  const connection = openSocket(url);
  try {
    await withinConnectionBudget(async signal => {
      await connection.opened; signal.throwIfAborted();
      await offer({ kind: 'relay', room: session }, signal);
    });
    await read(connection.socket, connection.next);
  }
  finally { connection.socket.close(); }
}
let succeeded = false;
for (const transport of metadata.transports) {
  status.textContent = '正在连接：' + ({ lan: '局域网', p2p: 'P2P', relay: '加密中继' })[transport];
  try { await connect(transport); status.textContent = '已连接：' + ({ lan: '局域网', p2p: 'P2P', relay: '加密中继' })[transport]; succeeded = true; break; }
  catch (error) { status.textContent = error.message; }
}
if (!succeeded) status.textContent = '无法连接到分享电脑，请确认电脑在线后刷新。';
} catch (error) {
  status.textContent = '无法打开分享：' + (error instanceof Error ? error.message : String(error));
  frame.hidden = true;
}
