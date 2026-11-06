import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Cs2RelayError, VacuumCs2Relay } from "./vacuumCs2Relay.js";

// Internal supervisor, invoked only with an IPC parent. Its lifetime bounds the native transport even after Manager failure.
if (!process.send || !process.connected) process.exit(2);
const args = process.argv.slice(2), [executable, configPath, timeoutJson] = args;
if (args.length !== 3 || !executable || !configPath || !timeoutJson) process.exit(2);
// This DTO comes only from the parent that already resolved the editable timeout configuration.
const timeouts = JSON.parse(timeoutJson) as { closeMs: number; localConnectMs: number; relayConnectMs: number };
let child: ChildProcess | undefined, relay: VacuumCs2Relay | undefined;
const controller = new AbortController();
let closing: Promise<void> | undefined;
let childClosed: Promise<void> | undefined;
let childExitConfirmed = false;
function close(): Promise<void> {
  if (closing) return closing;
  controller.abort(); relay?.close();
  const stopped = (async () => {
    delete process.env.RABI_VIDEO_SOURCE; delete process.env.RABI_VIDEO_PASSWORD;
    if (child && !childExitConfirmed) {
      try { child.kill("SIGTERM"); } catch { /* The close observation below remains authoritative. */ }
      let timer: NodeJS.Timeout | undefined;
      let confirmed: boolean;
      try { confirmed = await Promise.race([childClosed!.then(() => true), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeouts.closeMs);
      })]); } finally { if (timer) clearTimeout(timer); }
      if (!confirmed) throw new Error("Native video transport termination is unconfirmed.");
    }
    if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath);
    if (process.connected) process.disconnect();
    process.exit(0);
  })();
  closing = stopped;
  void stopped.catch(() => {
    if (closing === stopped) closing = undefined;
    if (process.connected) process.send?.({ event: "failed", code: "camera_transport_termination_unconfirmed" }, () => {});
  });
  return stopped;
}
process.once("disconnect", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
process.on("message", message => { if (message === "stop") void close(); });
try {
  const source = new URL(process.env.RABI_VIDEO_SOURCE || "");
  const peer = source.searchParams.get("cs2_peer"), servers = source.searchParams.get("cs2_servers");
  if (peer && servers && source.searchParams.get("vendor") === "cs2") {
    relay = new VacuumCs2Relay({ peer, servers: servers.split(",") });
    let connectionMode:"local"|"relay"="local";
    try{source.host=await relay.connectLocal(source.hostname,controller.signal,timeouts.localConnectMs);}
    catch{
      if(controller.signal.aborted)throw new Cs2RelayError("camera_relay_cancelled");
      relay.close();relay=new VacuumCs2Relay({peer,servers:servers.split(",")});
      source.host=await relay.connect(controller.signal,timeouts.relayConnectMs);connectionMode="relay";
    }
    if(process.connected)process.send?.({event:"connection",connectionMode});
    source.searchParams.delete("cs2_peer"); source.searchParams.delete("cs2_servers");
    process.env.RABI_VIDEO_SOURCE = source.href;
  }
  if (!closing) {
    child = spawn(executable!, ["-config", configPath!], { windowsHide: true, stdio: "ignore", env: process.env });
    childClosed = new Promise<void>(resolve => {
      const confirm = () => { childExitConfirmed = true; resolve(); };
      child!.once("exit", confirm); child!.once("close", confirm);
    });
    delete process.env.RABI_VIDEO_SOURCE; delete process.env.RABI_VIDEO_PASSWORD;
    child.once("spawn", () => { if (process.connected) process.send?.({ event: "ready", pid: child?.pid, parentPid: process.pid }); });
    child.once("error", () => { if (process.connected) process.send?.({ event: "failed" }); close(); });
    child.once("exit", () => { if (process.connected) process.send?.({ event: "exit" }); close(); });
  }
} catch (error) {
  if (process.connected && !closing) process.send?.({ event: "failed", code: error instanceof Cs2RelayError ? error.code : "camera_relay_connection_failed" });
  close();
}
