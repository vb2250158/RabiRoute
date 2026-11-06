import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { collectReleaseAssetPaths, readReleaseAsset } from "../apps/rabi-agent/lib/release-assets.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
async function files(root, relative = "") {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Windows runtime inputs cannot contain links: ${child}`);
    if (entry.isDirectory()) result.push(...await files(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result.sort();
}
async function copy(source, destination) { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); }
async function publishCandidate(source, destination) {
  // Windows can retain an image/DLL mapping briefly after the closure probe
  // exits. Retry only the atomic directory publication, never copy over output.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (attempt >= 49 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

export async function buildWindowsAgentBundle({ nodeRoot, expectedNodeVersion, expectedNodeArchitecture, outputRoot,
  agentRoot = path.join(repository, "apps/rabi-agent"), pluginSourceRoot }) {
  if (process.platform !== "win32") throw new Error("Build the Windows runtime bundle on Windows.");
  if (!nodeRoot || !expectedNodeVersion || !expectedNodeArchitecture || !outputRoot) throw new Error("Node root, expected version/architecture and output root are required.");
  nodeRoot = path.resolve(nodeRoot); outputRoot = path.resolve(outputRoot); agentRoot = path.resolve(agentRoot);
  if (pluginSourceRoot === undefined) {
    const sourceAgentRoot = await fs.realpath(path.join(repository, "apps/rabi-agent")).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (sourceAgentRoot && await fs.realpath(agentRoot) === sourceAgentRoot) pluginSourceRoot = repository;
  }
  const assetOptions = { pluginSourceRoot };
  if ([nodeRoot, outputRoot].some(root => root.startsWith("\\\\"))) throw new Error("Windows runtime inputs and output must use local disks.");
  for (const input of [nodeRoot, agentRoot]) {
    const relative = path.relative(input, outputRoot);
    if (!relative || !relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Windows bundle output must be outside its input trees.");
  }
  if (await fs.stat(outputRoot).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Windows bundle output already exists; choose a new candidate directory.");
  const node = path.join(nodeRoot, "node.exe"), npm = path.join(nodeRoot, "node_modules/npm/bin/npm-cli.js");
  const identity = JSON.parse((await execute(node, ["-p", "JSON.stringify({platform:process.platform,architecture:process.arch,nodeVersion:process.versions.node})"], { windowsHide: true })).stdout);
  if (identity.platform !== "win32" || identity.architecture !== expectedNodeArchitecture || identity.nodeVersion !== expectedNodeVersion)
    throw new Error("The explicit Node runtime does not match the expected Windows version/architecture.");
  const engine = JSON.parse(await fs.readFile(path.join(agentRoot, "package.json"), "utf8")).engines?.node;
  const minimum = typeof engine === "string" && /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engine);
  if (minimum) {
    const current = identity.nodeVersion.split(".").map(Number), required = minimum.slice(1).map(Number);
    const difference = current.map((part, n) => part - required[n]).find(part => part !== 0) ?? 0;
    if (difference < 0) throw new Error(`The selected Windows runtime does not satisfy the Agent engine requirement ${engine}.`);
  }
  const npmVersion = (await execute(node, [npm, "--version"], { windowsHide: true })).stdout.trim();
  for (const name of ["Terminal", "Computer", "Tray"]) await fs.access(path.join(agentRoot, `dist/native/RabiAgent.${name}.exe`));
  await fs.access(path.join(agentRoot, "package-lock.json"));
  const parent = path.dirname(outputRoot); await fs.mkdir(parent, { recursive: true });
  const stage = path.join(parent, `.windows-agent-bundle-${randomUUID()}`), runtime = path.join(stage, "windows-runtime");
  await fs.mkdir(stage);
  try {
    const assets = collectReleaseAssetPaths(agentRoot, "", assetOptions), inputFiles = [];
    for (const relative of assets) {
      const bytes = readReleaseAsset(agentRoot, relative, assetOptions), before = createHash("sha256").update(bytes).digest("hex");
      await fs.mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
      await fs.writeFile(path.join(stage, relative), bytes);
      if (createHash("sha256").update(readReleaseAsset(agentRoot, relative, assetOptions)).digest("hex") !== before || await sha256(path.join(stage, relative)) !== before) throw new Error(`Source changed while preparing the bundle: ${relative}`);
      inputFiles.push({ path: relative, sha256: before });
    }
    await fs.mkdir(runtime);
    const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(repository, "scripts/Set-WindowsExecutableIdentity.ps1"), "-Source", node,
      "-Destination", path.join(runtime, "RabiAgent.Runtime.exe"), "-Description", "Rabi Agent Runtime",
      "-Icon", path.join(agentRoot, "desktop/rabi-agent.ico")], { windowsHide: true, timeout: 120_000 });
    // npm package scripts conventionally execute `node`. Keep that name beside
    // the branded interpreter so scripts use the same version and product icon.
    try { await fs.link(path.join(runtime, "RabiAgent.Runtime.exe"), path.join(runtime, "node.exe")); }
    catch (error) {
      if (!["EPERM", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
      await fs.copyFile(path.join(runtime, "RabiAgent.Runtime.exe"), path.join(runtime, "node.exe"));
    }
    const npmRoot = path.join(nodeRoot, "node_modules/npm");
    for (const relative of await files(npmRoot)) await copy(path.join(npmRoot, relative), path.join(runtime, "node_modules/npm", relative));
    await copy(path.join(nodeRoot, "LICENSE"), path.join(runtime, "LICENSE.node.txt"));
    const runtimeFiles = [];
    for (const relative of await files(runtime)) runtimeFiles.push({ path: relative, size: (await fs.stat(path.join(runtime, relative))).size, sha256: await sha256(path.join(runtime, relative)) });
    const profile = { schemaVersion: 1, ...identity, npmVersion, sourceNodeSha256: await sha256(node), files: runtimeFiles };
    await fs.writeFile(path.join(stage, "windows-runtime.json"), JSON.stringify(profile, null, 2) + "\n");
    // Use the supplied interpreter and its npm, with the Agent's exact lockfile.
    await execute(node, [npm, "ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: stage, windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PATH: nodeRoot + path.delimiter + (process.env.PATH || ""), npm_config_arch: identity.architecture, npm_config_platform: "win32" } });
    const branded = JSON.parse((await execute(path.join(runtime, "RabiAgent.Runtime.exe"), ["-p", "JSON.stringify({platform:process.platform,architecture:process.arch,nodeVersion:process.versions.node})"], { windowsHide: true })).stdout);
    if (JSON.stringify(branded) !== JSON.stringify(identity)) throw new Error("Branding changed the selected runtime identity.");
    // The candidate lives outside the checkout. Loading the generated SDK and
    // the app's native dependencies here catches incomplete release inventories
    // and accidental dependency resolution through a developer checkout.
    const dependencyProbe = [
      'import path from "node:path"; import {createRequire} from "node:module";',
      'const require=createRequire(path.join(process.cwd(),"package.json")); const dependencies={};',
      'for(const name of ["ws","koffi"]){const resolved=require.resolve(name);const relative=path.relative(process.cwd(),resolved);',
      'if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Dependency escaped Windows bundle: "+name);',
      'await import(name);dependencies[name]=relative.replaceAll("\\\\","/");}',
      'await import("./rabi-agent.mjs");',
      'const sdk=await import("./runtime/management.mjs");if(typeof sdk.mountRemoteAgentManager!=="function")throw new Error("Generated SDK entry is incomplete");',
      'process.stdout.write(JSON.stringify({dependencies,sdkEntry:"runtime/management.mjs"}));'
    ].join("\n");
    const closure = JSON.parse((await execute(path.join(runtime, "RabiAgent.Runtime.exe"), ["--input-type=module", "-e", dependencyProbe],
      { cwd: stage, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
    for (const input of inputFiles) if (createHash("sha256").update(readReleaseAsset(agentRoot, input.path, assetOptions)).digest("hex") !== input.sha256) throw new Error(`Source changed before bundle publication: ${input.path}`);
    await fs.writeFile(path.join(stage, "windows-bundle-inputs.json"), JSON.stringify({ schemaVersion: 1, node: identity, sourceNodeSha256: profile.sourceNodeSha256, closure, agentFiles: inputFiles }, null, 2) + "\n");
    await publishCandidate(stage, outputRoot);
    return { outputRoot, nodeVersion: identity.nodeVersion, architecture: identity.architecture, runtimeFileCount: runtimeFiles.length, agentFileCount: assets.length };
  } finally {
    if (path.dirname(stage) !== parent || !/^\.windows-agent-bundle-[a-f0-9-]{36}$/.test(path.basename(stage))) throw new Error("Invalid Windows bundle cleanup scope.");
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = key => { const n = args.indexOf(key); return n < 0 ? undefined : args[n + 1]; };
  const result = await buildWindowsAgentBundle({ nodeRoot: value("--node-root"), expectedNodeVersion: value("--expected-node-version"),
    expectedNodeArchitecture: value("--expected-node-architecture"), outputRoot: value("--output-root"), agentRoot: value("--agent-root"), pluginSourceRoot: value("--plugin-source-root") });
  process.stdout.write(JSON.stringify(result) + "\n");
}
