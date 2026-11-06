import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adapterId = createHash("sha256").update(fileURLToPath(new URL("./index", import.meta.url))).digest("hex").slice(0, 24);
export const endpointDirectory = process.env.XIAOAI_BRIDGE_ENDPOINT_DIRECTORY || path.join(os.tmpdir(), `rabi-xiaoai-${adapterId}`);

export async function fetchPortBlocked(address) {
  try {
    const response = await fetch(address, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    return false;
  } catch (error) {
    return error instanceof TypeError && error.cause instanceof Error && error.cause.message === "bad port";
  }
}

/** Keep each OS allocation bound while probing; never switch an explicit port silently. */
export async function bindFetchCompatible(server, host, requestedPort, isBlocked = fetchPortBlocked) {
  for (let attempt = 0; attempt < 16; attempt++) {
    await new Promise((resolve, reject) => {
      const fail = error => reject(error);
      server.once("error", fail);
      server.listen(requestedPort, host, () => { server.off("error", fail); resolve(); });
    });
    try {
      const actual = server.address();
      if (!actual || typeof actual === "string") throw new Error("Bridge listening address is unavailable.");
      const localHost = actual.address === "0.0.0.0" ? "127.0.0.1" : actual.address === "::" ? "::1" : actual.address;
      const address = `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${actual.port}`;
      if (!await isBlocked(address)) return address;
    } catch (error) {
      await new Promise(resolve => server.close(resolve));
      throw error;
    }
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (requestedPort !== 0) throw new Error("The configured XiaoAI bridge port is blocked by Fetch.");
  }
  throw new Error("Unable to allocate a XiaoAI bridge port accepted by Fetch.");
}

export function publishEndpoint(address, instanceId) {
  fs.mkdirSync(endpointDirectory, { mode: 0o700, recursive: true });
  const directory = fs.lstatSync(endpointDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe XiaoAI endpoint directory.");
  const endpointFile = path.join(endpointDirectory, `${instanceId}.json`);
  fs.writeFileSync(endpointFile, JSON.stringify({ version: 1, address, instanceId }), { mode: 0o600, flag: "wx" });
  process.once("exit", () => {
    try {
      const record = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
      if (record.instanceId === instanceId) fs.unlinkSync(endpointFile);
    } catch { /* Keep any file whose ownership is uncertain. */ }
  });
}

/** Reject stale descriptors before the local diagnostic client uses them; this is not authentication. */
export async function discoverEndpoint() {
  const directory = fs.lstatSync(endpointDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe XiaoAI endpoint directory.");
  const names = fs.readdirSync(endpointDirectory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  if (names.length > 128) throw new Error("Too many XiaoAI bridge endpoint records; inspect the endpoint directory.");
  const checks = await Promise.allSettled(names.map(checkEndpoint));
  const active = checks.flatMap(check => check.status === "fulfilled" ? [check.value] : []);
  if (active.length !== 1) throw new Error(active.length ? "Multiple XiaoAI bridges are running; specify XIAOAI_BRIDGE_URL." : "No active XiaoAI bridge was found.");
  return active[0];
}

async function checkEndpoint(name) {
  const filename = path.join(endpointDirectory, name);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid local XiaoAI bridge endpoint.");
  const record = JSON.parse(fs.readFileSync(filename, "utf8"));
  const url = new URL(record.address);
  if (record.version !== 1 || typeof record.instanceId !== "string" || `${record.instanceId}.json` !== name
    || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid local XiaoAI bridge endpoint.");
  const response = await fetch(`${url.origin}/health`, { redirect: "error", signal: AbortSignal.timeout(3000) });
  const health = await response.json();
  if (!response.ok || health.instanceId !== record.instanceId) throw new Error("XiaoAI bridge endpoint is stale or belongs to another service.");
  return url.origin;
}
