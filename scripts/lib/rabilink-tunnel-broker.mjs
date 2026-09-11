import { WebSocketServer, WebSocket } from "ws";

/** Opaque, application-isolated pairing. Endpoint authentication remains end to end. */
export function attachTunnelBroker(server, authenticate) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 40_000, perMessageDeflate: false });
  const rooms = new Map();
  const upgrade = (req, socket, head) => {
    const url = new URL(req.url || "/", "http://relay.local");
    if (url.pathname !== "/api/rabilink/tunnel/socket") return;
    const app = authenticate(req, url);
    const roomId = url.searchParams.get("room") || "";
    if (!app || !/^[a-f0-9-]{36}$/.test(roomId)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const key = app + ":" + roomId;
    let room = rooms.get(key);
    if (!room && rooms.size >= 128 || room && room.sockets.length >= 2) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      if (!room) { room = { sockets: [], pending: [], pendingBytes: 0, bytes: 0, window: Date.now(), timer: undefined }; rooms.set(key, room); }
      room.sockets.push(ws);
      const close = () => { clearTimeout(room.timer); rooms.delete(key); for (const peer of room.sockets) peer.terminate(); };
      clearTimeout(room.timer); room.timer = setTimeout(close, room.sockets.length === 2 ? 65_000 : 10_000); room.timer.unref();
      ws.on("error", close); ws.on("close", close);
      ws.on("message", data => {
        clearTimeout(room.timer); room.timer = setTimeout(close, 65_000); room.timer.unref();
        if (Date.now() - room.window > 1_000) { room.window = Date.now(); room.bytes = 0; }
        room.bytes += data.length;
        if (room.bytes > 8 * 1024 * 1024) { close(); return; }
        const other = room.sockets.find(peer => peer !== ws);
        if (!other) {
          room.pendingBytes += data.length;
          if (room.pendingBytes > 16_384) { close(); return; }
          room.pending.push({ sender: ws, data: Buffer.from(data) }); return;
        }
        if (other.readyState !== WebSocket.OPEN || other.bufferedAmount > 2 * 1024 * 1024) { close(); return; }
        other.send(data, error => { if (error) close(); });
      });
      if (room.sockets.length === 2) {
        for (const item of room.pending) room.sockets.find(peer => peer !== item.sender)?.send(item.data);
        room.pending = []; room.pendingBytes = 0;
      }
    });
  };
  server.on("upgrade", upgrade);
  return { close() { server.removeListener("upgrade", upgrade); for (const room of rooms.values()) { clearTimeout(room.timer); for (const ws of room.sockets) ws.terminate(); } rooms.clear(); wss.close(); } };
}
