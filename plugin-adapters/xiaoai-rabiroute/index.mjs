import http from "node:http";

const host = process.env.XIAOAI_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.XIAOAI_BRIDGE_PORT || "8798");
const rabiRouteWebhookUrl = process.env.RABIROUTE_WEBHOOK_URL || "http://127.0.0.1:8791/webhook";

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      resolve(body ? JSON.parse(body) : {});
    });
    request.on("error", reject);
  });
}

async function forwardTranscript(payload) {
  const text = String(payload.text ?? payload.message ?? payload.content ?? "").trim();
  if (!text) {
    throw new Error("Missing text");
  }

  const upstreamPayload = {
    type: "voice_transcript",
    source: "xiaoai",
    sourceDeviceId: payload.sourceDeviceId ?? payload.deviceId,
    sourceDeviceName: payload.sourceDeviceName ?? payload.deviceName,
    sourceArea: payload.sourceArea ?? payload.area,
    sessionId: payload.sessionId,
    text,
    messageId: payload.messageId ?? payload.id ?? `xiaoai-${Date.now()}`,
    time: payload.time ?? Math.floor(Date.now() / 1000)
  };

  const response = await fetch(rabiRouteWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(upstreamPayload)
  });

  if (!response.ok) {
    throw new Error(`RabiRoute webhook returned ${response.status}: ${await response.text()}`);
  }

  return upstreamPayload;
}

const lastSpeakRequests = [];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        rabiRouteWebhookUrl,
        lastSpeakRequests: lastSpeakRequests.slice(-5)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/xiaoai/transcript") {
      const payload = await readJson(request);
      const forwarded = await forwardTranscript(payload);
      jsonResponse(response, 200, { ok: true, forwarded });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/xiaoai/speak") {
      const payload = await readJson(request);
      const item = {
        receivedAt: new Date().toISOString(),
        deviceId: payload.deviceId,
        text: payload.text,
        interrupt: payload.interrupt !== false,
        requestId: payload.requestId
      };
      lastSpeakRequests.push(item);
      console.log("[xiaoai:speak]", JSON.stringify(item));
      jsonResponse(response, 202, {
        ok: true,
        queued: item,
        note: "Speech output is a bridge placeholder. Wire this to the Open-XiaoAI server/client playback command next."
      });
      return;
    }

    jsonResponse(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    jsonResponse(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.log(`XiaoAI RabiRoute adapter listening on http://${host}:${port}`);
  console.log(`Forwarding transcripts to ${rabiRouteWebhookUrl}`);
});
