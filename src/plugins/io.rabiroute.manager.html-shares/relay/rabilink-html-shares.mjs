import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const viewerSource = await fs.readFile(new URL('../assets/rabilink-html-share-client.mjs', import.meta.url), 'utf8');
const page = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rabi HTML 分享</title><style>body{margin:0;font-family:system-ui}#status{padding:8px;background:#f3f5f7}iframe{border:0;width:100%;height:calc(100vh - 42px)}</style><div id="status">正在连接分享电脑…</div><iframe hidden sandbox="allow-scripts allow-forms allow-downloads allow-popups"></iframe><script type="module">' + viewerSource + '</script>';

/** Relay persists routing metadata only. Accepted sockets forward opaque PC-encrypted frames. */
export function createHtmlShareRelay(options) {
  const rooms = new Map();
  const server = new WebSocketServer({ noServer: true });
  const folder = path.join(options.directory, 'html-share-directory');
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = async req => { const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('Signaling request too large.'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString() || '{}'); };
  const lookup = async id => {
    if (!uuid(id)) throw new Error('Invalid share ID.');
    const record = JSON.parse(await fs.readFile(path.join(folder, id + '.json'), 'utf8'));
    const target = options.target(record.appId, record.deviceId);
    if (!target) throw new Error('Share PC is offline or its application is disabled.');
    return { record, target };
  };
  return {
    async handle(req, url, res) {
      const registration = url.pathname === '/worker/html-shares';
      const match = /^\/share\/([a-f0-9-]+)(?:\/(connection|offer))?\/?$/.exec(url.pathname);
      if (!registration && !match) return false;
      try {
        if (registration) {
          if (req.method !== 'POST') { json(res, 405, { error: 'POST required.' }); return true; }
          const body = await readBody(req), auth = options.authorize(req, url, body);
          if (!auth.ok || !auth.app || auth.deviceBinding) { json(res, 401, { error: 'PC application connection required.' }); return true; }
          if (!uuid(body.id)) { json(res, 400, { error: 'Invalid share ID.' }); return true; }
          const target = options.target(auth.app.id, body.deviceId || body.deviceGuid);
          if (!target) { json(res, 503, { error: 'Share PC is offline.' }); return true; }
          await fs.mkdir(folder, { recursive: true });
          const file = path.join(folder, body.id + '.json');
          let previous;
          try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (previous && (previous.appId !== auth.app.id || previous.deviceId !== target.worker.id)) { json(res, 409, { error: 'Share belongs to another PC.' }); return true; }
          const temporary = file + '.' + randomUUID() + '.tmp';
          if (!Array.isArray(body.transports) || !body.transports.length || !body.transports.every(value => typeof value === 'string')) throw new Error('PC transport priority is missing.');
          await fs.writeFile(temporary, JSON.stringify({ id: body.id, appId: auth.app.id, deviceId: target.worker.id, transports: body.transports })); await fs.rename(temporary, file);
          json(res, 200, { id: body.id }); return true;
        }
        const [, id, action] = match, { target, record } = await lookup(id);
        if (!action && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(page); return true;
        }
        if (action === 'connection' && req.method === 'GET') {
          json(res, 200, { peerUrls: target.worker.peerUrls || [], transports: record.transports }); return true;
        }
        if (action === 'offer' && req.method === 'POST') {
          const body = await readBody(req);
          if (body.kind === 'relay' && !rooms.has(id + ':' + body.room)) throw new Error('Viewer relay channel is not open.');
          // No arbitrary paths, headers, credentials or business APIs can enter this transport.
          if (!['p2p', 'relay'].includes(body.kind) || Object.keys(body).some(k => !['kind', 'sdp', 'room'].includes(k))) throw new Error('Invalid share offer.');
          const answer = await options.signal(req, target, id, body); json(res, 200, answer); return true;
        }
        json(res, 405, { error: 'Unsupported share method.' }); return true;
      } catch (error) { json(res, 503, { error: error.message }); return true; }
    },
    upgrade(req, socket, head) {
      const url = new URL(req.url || '/', 'http://relay'), match = /^\/share\/([a-f0-9-]+)\/socket$/.exec(url.pathname);
      if (!match) return false;
      void (async () => {
        const id = match[1], roomId = url.searchParams.get('room'), side = url.searchParams.get('side');
        if (!uuid(roomId) || !['pc', 'viewer'].includes(side)) throw new Error('Invalid share relay channel.');
        const { record } = await lookup(id);
        if (side === 'pc') { const auth = options.authorize(req, url, {}); if (!auth.ok || auth.deviceBinding || auth.app?.id !== record.appId) throw new Error('PC application required.'); }
        const key = id + ':' + roomId;
        let room = rooms.get(key);
        if (!room) { room = {}; rooms.set(key, room); room.timer = setTimeout(() => { room.pc?.terminate(); room.viewer?.terminate(); rooms.delete(key); }, 30000); room.timer.unref(); }
        if (room[side]) throw new Error('Channel side already connected.');
        server.handleUpgrade(req, socket, head, ws => {
          room[side] = ws;
          ws.on('message', (data, binary) => {
            const other = room[side === 'pc' ? 'viewer' : 'pc'];
            if (other?.readyState !== WebSocket.OPEN) { ws.close(); return; }
            ws.pause(); other.send(data, { binary }, error => { if (error) ws.terminate(); else ws.resume(); });
          });
          ws.on('error', () => ws.terminate());
          ws.on('close', () => { clearTimeout(room.timer); room[side === 'pc' ? 'viewer' : 'pc']?.close(); rooms.delete(key); });
          if (room.pc && room.viewer) clearTimeout(room.timer);
        });
      })().catch(() => socket.destroy()); return true;
    },
    stop() { for (const room of rooms.values()) { clearTimeout(room.timer); room.pc?.terminate(); room.viewer?.terminate(); } rooms.clear(); server.close(); }
  };
}
