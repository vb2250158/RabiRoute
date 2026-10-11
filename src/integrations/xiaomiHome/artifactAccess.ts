import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { once } from "node:events";
import { assertTrustedLanAgentPrincipal } from "../../manager/lanAgentRequestAccess.js";
import { createXiaomiHomeRequestAuthority } from "./requestAuthority.js";
import type http from "node:http";
import { XiaomiHomeManagerApiError } from "./managerApi.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";

export type XiaomiHomeArtifactAccessConfig = {
  artifactReadTokenEnv?: string;
};

export type ByteRange = { start: number; end: number };

export function parseSingleByteRange(header: string | undefined, size: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new XiaomiHomeManagerApiError(416, "xiaomi_home_artifact_range_invalid", "Artifact byte range is invalid.");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new XiaomiHomeManagerApiError(416, "xiaomi_home_artifact_range_invalid", "Artifact byte range is invalid.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    throw new XiaomiHomeManagerApiError(416, "xiaomi_home_artifact_range_invalid", "Artifact byte range is invalid.");
  }
  return { start, end: Math.min(end, size - 1) };
}

function safeHeader(value: string | string[] | undefined, fallback: string, maximum: number): string {
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || fallback).replace(/[\r\n]/g, " ").trim().slice(0, maximum) || fallback;
}

export class XiaomiHomeArtifactAccess {
  private readonly tokenEnv: string;

  constructor(
    config: XiaomiHomeArtifactAccessConfig,
    private readonly artifacts: XiaomiHomeArtifactStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.tokenEnv = String(config.artifactReadTokenEnv || "RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN").trim();
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(this.tokenEnv)) throw new Error("artifactReadTokenEnv is invalid.");
  }

  stream(request: http.IncomingMessage, response: http.ServerResponse, artifactId: string): void {
    const authority = createXiaomiHomeRequestAuthority(request);
    authority.assert();
    const principal = assertTrustedLanAgentPrincipal(request);
    const configured = String(this.env[this.tokenEnv] || "").trim();
    if (!configured) throw new XiaomiHomeManagerApiError(503, "xiaomi_home_artifact_authorization_required", `Set ${this.tokenEnv} in the local RabiRoute runtime environment.`);
    const authorization = String(request.headers.authorization || "");
    const presented = principal ? String(request.headers["x-rabiroute-artifact-token"] || "").trim()
      : authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const expectedBytes = Buffer.from(configured);
    const presentedBytes = Buffer.from(presented);
    if (expectedBytes.length !== presentedBytes.length || !timingSafeEqual(expectedBytes, presentedBytes)) {
      throw new XiaomiHomeManagerApiError(401, "xiaomi_home_artifact_unauthorized", "Artifact read authorization failed.");
    }
    const descriptor = this.artifacts.contentDescriptor(artifactId);
    if (!descriptor) throw new XiaomiHomeManagerApiError(404, "xiaomi_home_artifact_not_found", "Artifact content was not found.");
    const stat = fs.statSync(descriptor.localPath);
    const range = parseSingleByteRange(String(request.headers.range || "") || undefined, stat.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const contentLength = end - start + 1;
    const actor = safeHeader(request.headers["x-rabi-agent-role"], "local-agent", 80);
    const reason = safeHeader(request.headers["x-rabi-read-reason"], "artifact-read", 240);
    this.artifacts.recordAccess({ artifactId, actor, reason, byteRange: range ? `bytes=${start}-${end}` : undefined });
    authority.assert();
    response.writeHead(range ? 206 : 200, {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": contentLength,
      "content-type": descriptor.record.mediaKind,
      ...(range ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {})
    });
    const source = fs.createReadStream(descriptor.localPath, { start, end });
    const closed = new AbortController();
    const onClose = () => { closed.abort(); source.destroy(); };
    response.once("close", onClose);
    void (async () => {
      try {
        for await (const chunk of source) {
          authority.assert();
          if (!response.write(chunk)) {
            await once(response, "drain", { signal: closed.signal });
            authority.assert();
          }
        }
        authority.assert();
        response.end();
      } catch {
        source.destroy();
        response.destroy();
      } finally {
        response.off("close", onClose);
        source.destroy();
      }
    })();
  }
}
