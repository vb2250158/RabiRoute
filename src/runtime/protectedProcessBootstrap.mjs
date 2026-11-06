// This trusted entry imports no business module and starts no process before self-admission.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { joinCurrentProcessToJob } from "./windowsJobObject.mjs";

let launch;
try {
  launch = JSON.parse(process.env.RABIROUTE_PROTECTED_LAUNCH || "null");
  delete process.env.RABIROUTE_PROTECTED_LAUNCH;
  if (!launch || !["fork", "spawn"].includes(launch.kind) || typeof launch.job !== "string") throw new Error("Missing protected process launch.");
  joinCurrentProcessToJob(launch.job);
  fs.writeSync(launch.controlFd, JSON.stringify({ nonce: launch.nonce, state: "admitted" }) + "\n");
  fs.closeSync(launch.controlFd);
} catch (error) {
  try { if (launch) fs.writeSync(launch.controlFd, JSON.stringify({ nonce: launch.nonce, state: "failed", message: String(error.message) }) + "\n"); } catch {}
  process.stderr.write("Protected process admission failed; business entry was not executed.\n");
  process.exit(1);
}

if (launch.kind === "fork") {
  process.argv = [process.execPath, launch.entry, ...launch.args];
  process.execArgv = launch.originalExecArgv;
  if (launch.nodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = launch.nodeOptions;
  const require = createRequire(path.join(process.cwd(), "__preload__.cjs"));
  for (const specifier of launch.preloads.requires) require(specifier);
  const parentURL = pathToFileURL(path.join(process.cwd(), "__preload__.mjs")).href;
  for (const specifier of launch.preloads.imports) await import(import.meta.resolve(specifier, parentURL));
  await import(pathToFileURL(launch.entry).href);
} else {
  if (launch.nodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = launch.nodeOptions;
  const child = spawn(launch.command, launch.args, { ...launch.options, env: process.env, stdio: "inherit" });
  child.once("error", error => { process.stderr.write(`Protected command could not start: ${error.code || error.name}.\n`); process.exitCode = 1; if (process.connected) process.disconnect(); });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); if (process.connected) process.disconnect(); });
}
