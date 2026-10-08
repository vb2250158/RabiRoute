import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { Cs2RelayError, VacuumCs2Relay } from "./vacuumCs2Relay.js";

// Internal supervisor, invoked only with an IPC parent. Its lifetime bounds the native transport even after Manager failure.
if (!process.send || !process.connected) process.exit(2);
const args = process.argv.slice(2), [executable, configPath] = args;
if (args.length !== 2 || !executable || !configPath) process.exit(2);
let child: ChildProcess | undefined, relay: VacuumCs2Relay | undefined;
const controller = new AbortController();
let closing = false;
function close() {
  if (closing) return; closing = true;
  controller.abort(); relay?.close(); child?.kill();
  delete process.env.RABI_VIDEO_SOURCE; delete process.env.RABI_VIDEO_PASSWORD;
  if (configPath && fs.existsSync(configPath)) fs.unlinkSync(configPath);
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once("disconnect", close); process.once("SIGTERM", close);
process.on("message", message => { if (message === "stop") close(); });
try {
  const source = new URL(process.env.RABI_VIDEO_SOURCE || "");
  const peer = source.searchParams.get("cs2_peer"), servers = source.searchParams.get("cs2_servers");
  if (peer && servers && source.searchParams.get("vendor") === "cs2") {
    relay = new VacuumCs2Relay({ peer, servers: servers.split(",") });
    let connectionMode:"local"|"relay"="local";
    try{source.host=await relay.connectLocal(source.hostname,controller.signal);}
    catch{
      if(controller.signal.aborted)throw new Cs2RelayError("camera_relay_cancelled");
      relay.close();relay=new VacuumCs2Relay({peer,servers:servers.split(",")});
      source.host=await relay.connect(controller.signal);connectionMode="relay";
    }
    if(process.connected)process.send?.({event:"connection",connectionMode});
    source.searchParams.delete("cs2_peer"); source.searchParams.delete("cs2_servers");
    process.env.RABI_VIDEO_SOURCE = source.href;
  }
  if (!closing) {
    child = spawn(executable!, ["-config", configPath!], { windowsHide: true, stdio: "ignore", env: process.env });
    delete process.env.RABI_VIDEO_SOURCE; delete process.env.RABI_VIDEO_PASSWORD;
    child.once("spawn", () => { if (process.connected) process.send?.({ event: "ready", pid: child?.pid, parentPid: process.pid }); });
    child.once("error", () => { if (process.connected) process.send?.({ event: "failed" }); close(); });
    child.once("exit", () => { if (process.connected) process.send?.({ event: "exit" }); close(); });
  }
} catch (error) {
  if (process.connected && !closing) process.send?.({ event: "failed", code: error instanceof Cs2RelayError ? error.code : "camera_relay_connection_failed" });
  close();
}
