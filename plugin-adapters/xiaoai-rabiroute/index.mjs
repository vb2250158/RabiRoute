import http from "node:http";

const host = process.env.XIAOAI_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.XIAOAI_BRIDGE_PORT || "8798");
const rabiRouteWebhookUrl = process.env.RABIROUTE_WEBHOOK_URL || "http://127.0.0.1:8791/webhook";
const interceptPatternText = process.env.XIAOAI_INTERCEPT_REGEX || "^(问\\s*Rabi|让\\s*Rabi|Rabi|找\\s*Rabi|兔兔|问\\s*兔兔)";
const interceptPattern = new RegExp(interceptPatternText, "i");
const defaultInterceptSpeakText = process.env.XIAOAI_INTERCEPT_SPEAK_TEXT || "收到，已经转给 Rabi。";

const counters = {
  transcripts: 0,
  decisions: 0,
  intercepted: 0,
  ignored: 0,
  forwardErrors: 0
};

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

function extractText(payload) {
  return String(payload.text ?? payload.message ?? payload.content ?? "").trim();
}

function normalizeTranscript(payload) {
  const text = String(payload.text ?? payload.message ?? payload.content ?? "").trim();
  if (!text) {
    throw new Error("Missing text");
  }

  return {
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
}

async function forwardTranscript(payload) {
  const upstreamPayload = normalizeTranscript(payload);

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

async function buildDecision(payload) {
  const text = extractText(payload);
  if (!text) {
    throw new Error("Missing text");
  }

  const matched = interceptPattern.test(text);
  const forwarded = await forwardTranscript(payload);
  counters.decisions += 1;

  if (!matched) {
    counters.ignored += 1;
    return {
      ok: true,
      action: "ignore",
      reason: "No intercept rule matched. Native XiaoAI should continue.",
      forwarded
    };
  }

  counters.intercepted += 1;
  return {
    ok: true,
    action: "intercept",
    reason: "Matched local XiaoAI intercept rule.",
    speakText: defaultInterceptSpeakText,
    matchedRule: interceptPatternText,
    forwarded
  };
}

const lastSpeakRequests = [];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        rabiRouteWebhookUrl,
        interceptPattern: interceptPatternText,
        counters,
        lastSpeakRequests: lastSpeakRequests.slice(-5)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/xiaoai/transcript") {
      const payload = await readJson(request);
      let forwarded;
      try {
        forwarded = await forwardTranscript(payload);
        counters.transcripts += 1;
      } catch (error) {
        counters.forwardErrors += 1;
        throw error;
      }
      jsonResponse(response, 200, { ok: true, forwarded });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/xiaoai/decision") {
      const payload = await readJson(request);
      let decision;
      try {
        decision = await buildDecision(payload);
      } catch (error) {
        counters.forwardErrors += 1;
        throw error;
      }
      jsonResponse(response, 200, decision);
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
  console.log(`XiaoAI intercept regex: ${interceptPatternText}`);
});
