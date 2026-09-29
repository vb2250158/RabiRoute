import path from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { readPublicJson } from "./manager-discovery.mjs";
import { businessReady } from "./endpoint-session.mjs";

const MAX_DESCRIPTOR_BYTES = 65536;
function nonempty(value) { return typeof value === "string" && value.trim().length > 0; }
function origin(value) {
  if (!nonempty(value) || value !== value.trim() || /[\\\s?#]/.test(value)) throw new Error("Invalid Manager origin.");
  // Inspect the raw path too: URL normalization must not erase /a/.. or /.
  if (!/^http:\/\/[^/]+\/?$/.test(value)) throw new Error("Invalid Manager origin.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid Manager origin.");
  return url.origin;
}

/** Resolve only the installed Host's current endpoint; never launch a runtime or a business operation. */
export function createHostEndpointSession({ hostExecutable, env = process.env, spawnSync = defaultSpawnSync, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw new Error("Host endpoint timeout must be between 1 and 12000 milliseconds.");
  const configured = hostExecutable ?? env.RABIROUTE_HOST_EXE;
  const executable = nonempty(configured) ? configured.trim()
    : nonempty(env.LOCALAPPDATA) ? path.join(env.LOCALAPPDATA, "Programs", "RabiRoute", "RabiRouteHost.exe") : "";
  if (!executable || /[\r\n\0]/.test(executable)) throw new Error("Configure a valid RabiRoute Host executable.");
  return {
    async ensure({ diagnostic = false } = {}) {
      let descriptor;
      try {
        const result = spawnSync(executable, ["--command", "status", "--json"], {
          encoding: "utf8", windowsHide: true, shell: false, timeout: timeoutMs,
          maxBuffer: MAX_DESCRIPTOR_BYTES, env
        });
        if (!result || result.error || result.status !== 0 || result.signal) throw new Error();
        const output = result.stdout;
        if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_DESCRIPTOR_BYTES) throw new Error();
        descriptor = JSON.parse(output);
        if (descriptor?.ok !== true || !nonempty(descriptor.applicationGenerationId) || !nonempty(descriptor.managerInstanceId)) throw new Error();
      } catch {
        throw new Error("RabiRoute Host did not return a valid current Manager descriptor; check Host availability and configuration.");
      }
      let managerUrl;
      try { managerUrl = origin(descriptor.managerBaseUrl); }
      catch { throw new Error("RabiRoute Host returned an invalid loopback Manager origin."); }
      let meta;
      try {
        const raw = await readPublicJson(fetchImpl, `${managerUrl}/meta`, AbortSignal.timeout(timeoutMs));
        if (raw && Object.hasOwn(raw, "data")) {
          if (raw.code !== 0 || !raw.data || typeof raw.data !== "object" || Array.isArray(raw.data)) throw new Error();
          meta = raw.data;
        } else { meta = raw; }
        if (!meta || meta.applicationGenerationId !== descriptor.applicationGenerationId || meta.managerInstanceId !== descriptor.managerInstanceId) throw new Error();
      } catch {
        throw new Error("Manager metadata is unavailable or does not match the current Host identity.");
      }
      if (!diagnostic && !businessReady(meta)) throw new Error("Manager is not ready for business requests; inspect diagnostic metadata.");
      return { managerUrl, meta };
    }
  };
}
