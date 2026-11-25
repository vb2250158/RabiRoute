import { createHash } from "node:crypto";
import { RelayProxyRequestQueue } from "./rabilink-proxy-request-queue.mjs";

export const phoneFilesCapability = "phone-files-v1";
export const phoneFilesPath = "/api/rabilink/mobile/files";
const timeoutMs = 30_000;
const actions = new Set([
  "file.list", "file.stat", "file.read", "file.mkdir", "file.rename", "file.delete", "file.settings.read", "file.settings.update",
  "upload.begin", "upload.write", "upload.status", "upload.commit", "upload.abort"
]);
const readActions = new Set(["file.list", "file.stat", "file.read", "file.settings.read", "upload.status"]);
const secretHash = secret => createHash("sha256").update(secret).digest("hex");

export function createPhoneFilesRelay({ events, sendJson, selectPhone, callerIsCurrent }) {
  const sessions = new Map();
  const queue = new RelayProxyRequestQueue({
    name: "Phone file", idPrefix: "phone-file", requestWaitMs: timeoutMs, leaseMs: timeoutMs * 2, retentionMs: 0
  });
  const key = (appId, id) => JSON.stringify([appId, id]);
  const headers = { "cache-control": "private, no-store" };
  const failure = (res, status, errorCode) => sendJson(res, status, { code: -1, errorCode }, headers);
  const owns = (request, session) => request.appId === session.appId && request.targetDeviceId === session.id
    && request.phoneSession === session && callerIsCurrent(request.caller);

  return {
    connect(appId, id, appTokenHash, secret) {
      const session = { appId, id, appTokenHash, hash: secretHash(secret), pending: 0 };
      const identity = key(appId, id);
      sessions.set(identity, session);
      return () => { if (sessions.get(identity) === session) sessions.delete(identity); };
    },
    async handle(req, url, res, auth, body) {
      if (req.method !== "POST") return failure(res, 405, "PHONE_FILES_METHOD_INVALID");
      if (auth.deviceBinding || !req.headers["x-rabilink-token"]) return failure(res, 403, "PHONE_FILES_CREDENTIAL_REQUIRED");
      if (url.pathname === phoneFilesPath) {
        const { action, targetId, targetGuid, ...input } = body ?? {};
        if (!actions.has(action) || typeof targetId !== "string" || !targetId || typeof targetGuid !== "string") {
          return failure(res, 400, "PHONE_FILES_REQUEST_INVALID");
        }
        const target = selectPhone(auth, targetId, targetGuid);
        if (!target) return failure(res, 404, "PHONE_FILES_DEVICE_UNKNOWN");
        const session = sessions.get(key(target.app.id, target.worker.id));
        if (!session || session.appTokenHash !== secretHash(target.app.token)) {
          return failure(res, 503, "PHONE_FILES_NOT_CONNECTED");
        }
        if (session.pending >= 4 || queue.counts().total >= 64) return failure(res, 429, "PHONE_FILES_BUSY");
        const caller = { appId: auth.app.id, credentialHash: auth.pcCredential?.credentialHash ?? secretHash(auth.app.token),
          targetAppId: target.app.id, targetId, targetGuid };
        const request = queue.create({ appId: session.appId, targetDeviceId: session.id, path: action,
          method: readActions.has(action) ? "GET" : "POST", bodyBase64: Buffer.from(JSON.stringify(input)).toString("base64") });
        Object.assign(request, { phoneSession: session, caller });
        session.pending += 1;
        const cancel = () => queue.expire(request.id, "PHONE_FILES_CLIENT_CLOSED");
        res.once("close", cancel);
        try {
          events.publish("phone_files_available", { appId: session.appId, targetDeviceId: session.id, deviceKind: "phone" });
          await queue.waitForCompletion(request, timeoutMs);
          if (res.destroyed) return;
          if (!request.response) return failure(res, 504, request.attempts && request.nonReplayable
            ? "PHONE_FILES_OUTCOME_UNCERTAIN" : "PHONE_FILES_TIMEOUT");
          if (!callerIsCurrent(caller)) return failure(res, 403, "PHONE_FILES_CREDENTIAL_CHANGED");
          return sendJson(res, request.response.statusCode, request.response.body, headers);
        } finally {
          res.off("close", cancel);
          session.pending -= 1;
          queue.requests.delete(request.id);
        }
      }
      if (![phoneFilesPath + "/claim", phoneFilesPath + "/result"].includes(url.pathname)) {
        return failure(res, 404, "PHONE_FILES_ENDPOINT_UNKNOWN");
      }
      const id = body?.phoneId;
      const secret = req.headers["x-rabilink-phone-session"];
      const session = typeof id === "string" && sessions.get(key(auth.app.id, id));
      if (auth.pcCredential || !session || typeof secret !== "string" || session.hash !== secretHash(secret)
        || session.appTokenHash !== secretHash(auth.app.token)) {
        return failure(res, 403, "PHONE_FILES_SESSION_INVALID");
      }
      if (url.pathname.endsWith("/claim")) {
        const [request] = queue.claim(1, candidate => owns(candidate, session));
        return sendJson(res, 200, { code: 0, data: request ? {
          id: request.id, action: request.path, remainingMs: Math.max(0, request.expiresAt - Date.now()),
          input: JSON.parse(Buffer.from(request.bodyBase64, "base64").toString("utf8"))
        } : null }, headers);
      }
      const request = typeof body.requestId === "string" && queue.get(body.requestId);
      if (!request || request.status !== "leased" || !owns(request, session)) return failure(res, 404, "PHONE_FILES_REQUEST_UNKNOWN");
      if (!Number.isInteger(body.status) || body.status < 200 || body.status > 599 || !body.result
        || typeof body.result !== "object" || Array.isArray(body.result)) return failure(res, 400, "PHONE_FILES_RESULT_INVALID");
      queue.complete(request.id, { statusCode: body.status });
      request.response.body = body.result;
      return sendJson(res, 200, { code: 0 }, headers);
    }
  };
}
