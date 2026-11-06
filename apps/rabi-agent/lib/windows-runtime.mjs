import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { launcherLeaseTarget } from "./cold-release-adoption.mjs";

const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fileHash(filename) {
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}
function profilePath(root, relative) {
  if (typeof relative !== "string" || relative.includes("\\") || path.posix.isAbsolute(relative)
    || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid Windows runtime asset path.");
  return path.join(root, ...relative.split("/"));
}
async function requireRuntimeDirectory(directory, missing = false) {
  const stat = await fs.promises.lstat(directory).catch(error => {
    if (missing && error.code === "ENOENT") return undefined; throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (await fs.promises.realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase())
    throw new Error("The private Windows runtime directory must not redirect outside its instance.");
  return true;
}
async function verifyRuntime(root, profile) {
  await requireRuntimeDirectory(root);
  // Share directory checks only within this one complete verification, never
  // retain a receipt or an earlier snapshot as proof of current runtime bytes.
  const directories = new Set([root]);
  for (const file of profile.files) {
    const filename = profilePath(root, file.path);
    const parents = [];
    for (let directory = path.dirname(filename); !directories.has(directory); directory = path.dirname(directory)) parents.unshift(directory);
    for (const directory of parents) { await requireRuntimeDirectory(directory); directories.add(directory); }
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || await fileHash(filename) !== file.sha256)
      throw Object.assign(new Error(`Windows runtime asset does not match its bundle: ${file.path}`), { code: "RABI_AGENT_RUNTIME_ASSET_MISMATCH" });
  }
}
async function ownerLease(configPath) {
  const target = fs.existsSync(configPath) ? launcherLeaseTarget(configPath) : `\\\\.\\pipe\\rabi-agent-${hash(path.join(await fs.promises.realpath(path.dirname(configPath)), path.basename(configPath)).toLowerCase())}`;
  const lease = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    lease.once("error", error => reject(Object.assign(new Error(error.code === "EADDRINUSE"
      ? "The original Rabi Agent owner is active; stop it before replacing its private runtime."
      : "The original Rabi Agent owner boundary could not be verified.", { cause: error }),
      { code: error.code === "EADDRINUSE" ? "RABI_AGENT_RUNTIME_BUSY" : "RABI_AGENT_RUNTIME_OWNER_UNVERIFIED" })));
    lease.listen(target, resolve);
  });
  return lease;
}

/** Prepare only the explicit Windows bundle. The generic Node release stays unchanged. */
export async function prepareWindowsRuntime({ bundleRoot, configPath }) {
  if (process.platform !== "win32") throw new Error("This runtime bundle is for Windows.");
  bundleRoot = path.resolve(bundleRoot); configPath = path.resolve(configPath);
  const receiptBytes = await fs.promises.readFile(path.join(bundleRoot, "windows-runtime.json"));
  const profile = JSON.parse(receiptBytes);
  if (profile.schemaVersion !== 1 || profile.platform !== "win32" || profile.architecture !== process.arch
    || !/^\d+\.\d+\.\d+$/.test(profile.nodeVersion) || !Array.isArray(profile.files)
    || !profile.files.some(file => file.path === "RabiAgent.Runtime.exe")
    || !profile.files.some(file => file.path === "node_modules/npm/bin/npm-cli.js")) throw new Error("Windows runtime version or architecture does not match this process.");
  const source = path.join(bundleRoot, "windows-runtime"), state = path.dirname(configPath);
  await fs.promises.mkdir(state, { recursive: true });
  const canonicalState = await fs.promises.realpath(state);
  configPath = fs.existsSync(configPath) ? await fs.promises.realpath(configPath) : path.join(canonicalState, path.basename(configPath));
  const parent = path.join(canonicalState, "runtime"); await fs.promises.mkdir(parent, { recursive: true });
  const canonicalParent = await fs.promises.realpath(parent);
  if (canonicalParent.toLowerCase() !== path.join(canonicalState, "runtime").toLowerCase()) throw new Error("The private runtime directory redirects outside this Agent instance.");
  const runtime = path.join(parent, `windows-${profile.architecture}`), executable = path.join(runtime, "RabiAgent.Runtime.exe");
  const installed = await requireRuntimeDirectory(runtime, true);
  const same = installed && await fs.promises.readFile(path.join(runtime, "runtime-profile.json")).then(bytes => bytes.equals(receiptBytes), error => {
    if (error.code === "ENOENT") return false; throw error;
  });
  let reusable = false;
  if (same) {
    try { await verifyRuntime(runtime, profile); reusable = true; }
    catch (error) {
      // Missing/damaged assets use the original owner lease and staged repair.
      // A redirected directory is rejected without traversing or deleting it.
      if (!["ENOENT", "ENOTDIR", "RABI_AGENT_RUNTIME_ASSET_MISMATCH"].includes(error.code)) throw error;
    }
  }
  if (reusable) return { executable, profile, reused: true, configPath };
  const lease = await ownerLease(configPath);
  const stage = path.join(parent, `.windows-runtime-${randomUUID()}`), backup = path.join(parent, `.windows-before-${randomUUID()}`);
  let backedUp = false, committed = false;
  const previousExecutables = [];
  async function closePreviousExecutables() {
    const closed = await Promise.allSettled(previousExecutables.splice(0).map(file => file.close()));
    const failed = closed.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  try {
    for (const existing of [executable, path.join(runtime, "node.exe")]) if (fs.existsSync(existing)) {
      const stat = await fs.promises.lstat(existing);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid private Windows runtime executable.");
      // A write-capable probe rejects an image that Windows still has mapped,
      // including a transient CLI outside the main owner lease.
      previousExecutables.push(await fs.promises.open(existing, "r+"));
    }
    // The explicitly selected source bundle is read-only and may have an alias.
    // Its generated installed runtime, checked above, must remain instance-local.
    await verifyRuntime(await fs.promises.realpath(source), profile);
    await fs.promises.mkdir(stage);
    for (const file of profile.files) {
      const target = profilePath(stage, file.path); await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (file.path === "node.exe") {
        try { await fs.promises.link(path.join(stage, "RabiAgent.Runtime.exe"), target); }
        catch (error) {
          if (!["EPERM", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
          await fs.promises.copyFile(path.join(stage, "RabiAgent.Runtime.exe"), target);
        }
      } else await fs.promises.copyFile(profilePath(source, file.path), target);
    }
    await verifyRuntime(stage, profile);
    await fs.promises.writeFile(path.join(stage, "runtime-profile.json"), receiptBytes, { flag: "wx" });
    // Windows refuses renaming a directory while its child files are open.
    // Keep the main-owner lease throughout the commit; if another transient
    // image maps now, the directory rename itself fails with the old path intact.
    await closePreviousExecutables();
    if (fs.existsSync(runtime)) {
      const stat = await fs.promises.lstat(runtime);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid private Windows runtime target.");
      await fs.promises.rename(runtime, backup); backedUp = true;
    }
    try { await fs.promises.rename(stage, runtime); committed = true; }
    catch (error) { if (backedUp) { await fs.promises.rename(backup, runtime); backedUp = false; } throw error; }
    return { executable, profile, reused: false, configPath };
  } finally {
    // These unique siblings are the only recursive cleanup scope.
    try {
      await closePreviousExecutables();
      for (const scratch of [stage, ...(committed && backedUp ? [backup] : [])]) {
        if (path.dirname(scratch) !== parent || !/^\.windows-(runtime|before)-[a-f0-9-]{36}$/.test(path.basename(scratch))) throw new Error("Invalid private runtime cleanup scope.");
        await fs.promises.rm(scratch, { recursive: true, force: true });
      }
    } finally { await new Promise(resolve => lease.close(resolve)); }
  }
}

export async function startWindowsRuntime({ bundleRoot, configPath, bootstrap = false }) {
  const prepared = await prepareWindowsRuntime({ bundleRoot, configPath });
  configPath = prepared.configPath;
  const launcher = path.join(path.dirname(path.resolve(configPath)), "rabi-agent-launcher.mjs");
  if (fs.existsSync(launcher)) {
    try {
      const current = JSON.parse((await execute(prepared.executable, [launcher, "--config", path.resolve(configPath), "--command", "status"], { windowsHide: true, timeout: 5000 })).stdout);
      if (current.ok) return { status: "already_running", pid: current.pid, executable: prepared.executable };
    } catch { /* The normal main-program lease still decides concurrent startup. */ }
  }
  // This is an installer-to-application handoff. The transient launcher exits;
  // the branded main program owns its own workers and native presentation.
  const child = spawn(prepared.executable, [path.join(path.resolve(bundleRoot), "rabi-agent.mjs"), "--config", path.resolve(configPath), ...(bootstrap ? ["--bootstrap"] : [])],
    { cwd: path.resolve(bundleRoot), windowsHide: true, detached: true, stdio: "ignore", env: process.env });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return { status: "started", pid: child.pid, executable: prepared.executable };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = process.argv.indexOf("--config");
  if (config < 0 || !process.argv[config + 1]) throw new Error("--config is required.");
  const bundleRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = await startWindowsRuntime({ bundleRoot, configPath: process.argv[config + 1], bootstrap: process.argv.includes("--bootstrap") });
  process.stdout.write(JSON.stringify(result) + "\n");
}
