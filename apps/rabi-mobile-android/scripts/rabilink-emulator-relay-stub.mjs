import http from "node:http";

const host = process.env.RABI_EMULATOR_STUB_HOST || "0.0.0.0";
const port = Number(process.env.RABI_EMULATOR_STUB_PORT || 18894);
const startedAt = new Date().toISOString();
const state = {
  startedAt,
  requests: 0,
  audioStarts: 0,
  audioChunks: 0,
  audioBytes: 0,
  audioStops: 0,
  lastSequence: null,
  lastStreamId: "",
  lastSourceDeviceId: "",
  lastRouteProfileId: "",
};

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function mobileState() {
  return {
    ok: true,
    workers: [{ id: "emulator-pc", name: "Rabi Emulator PC", online: true }],
    selectedWorker: { id: "emulator-pc", name: "Rabi Emulator PC", online: true },
  };
}

const server = http.createServer(async (request, response) => {
  state.requests += 1;
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname.startsWith("/rabilink/")
    ? url.pathname.slice("/rabilink".length)
    : url.pathname;

  if (pathname === "/__state") {
    json(response, 200, { ok: true, ...state });
    return;
  }

  if (pathname === "/api/rabilink/mobile/state") {
    json(response, 200, mobileState());
    return;
  }

  if (pathname === "/api/rabilink/mobile/select-pc") {
    await readBody(request);
    json(response, 200, mobileState());
    return;
  }

  if (pathname === "/api/rabilink/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("event: ready\ndata: {}\n\n");
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 5000);
    request.on("close", () => clearInterval(keepalive));
    return;
  }

  if (pathname === "/api/rabilink/devices/messages") {
    json(response, 200, { ok: true, messages: [], nextCursor: url.searchParams.get("after") || "" });
    return;
  }

  if (pathname.endsWith("/audio-streams/rabilink/start")) {
    const body = JSON.parse((await readBody(request)).toString("utf8") || "{}");
    state.audioStarts += 1;
    state.lastStreamId = String(body.stream_id || "");
    state.lastSourceDeviceId = String(body.source_device_id || "");
    state.lastRouteProfileId = String(body.route_profile_id || "");
    json(response, 200, { ok: true, stream_id: state.lastStreamId });
    return;
  }

  if (pathname.endsWith("/audio-streams/rabilink/chunk")) {
    const body = await readBody(request);
    state.audioChunks += 1;
    state.audioBytes += body.length;
    state.lastSequence = Number(url.searchParams.get("sequence") || 0);
    json(response, 200, { ok: true });
    return;
  }

  if (pathname.endsWith("/audio-streams/rabilink/stop")) {
    await readBody(request);
    state.audioStops += 1;
    json(response, 200, { ok: true });
    return;
  }

  await readBody(request);
  json(response, 200, { ok: true });
});

server.listen(port, host, () => {
  process.stdout.write(`RabiLink emulator relay stub listening on ${host}:${port}\n`);
});
