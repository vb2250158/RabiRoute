import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";
import { captureAutomaticInputs, automaticInputsUnchanged, writeAutomaticSnapshot } from "./automatic-update-inputs.mjs";
import { webPatchInputs, isWebPatchInput } from "./web-patch-inputs.mjs";

export const automaticWebInputs = [...webPatchInputs, "src", "tsconfig.json", "scripts/lib/discover-manager-url.mjs"];

function extractVueScript(text) {
  return [...text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .join("\n");
}

export async function captureAutomaticWebInputs(root) {
  const snapshot = await captureAutomaticInputs(root, automaticWebInputs);
  const relevant = new Set([...snapshot.files.keys()].filter(isWebPatchInput));
  const configurationPath = path.join(root, "ribiwebgui/tsconfig.json");
  const configurationText = snapshot.files.get("ribiwebgui/tsconfig.json");
  const raw = configurationText ? ts.parseConfigFileTextToJson(configurationPath, configurationText.toString()).config : {};
  const configuration = ts.parseJsonConfigFileContent(raw ?? {}, ts.sys, path.dirname(configurationPath));
  const host = {
    fileExists: filename => {
      const relative = path.relative(root, filename).replaceAll("\\", "/");
      return relative.startsWith("../") || relative.includes("node_modules/") ? ts.sys.fileExists(filename) : snapshot.files.has(relative);
    },
    readFile: filename => snapshot.files.get(path.relative(root, filename).replaceAll("\\", "/"))?.toString() ?? ts.sys.readFile(filename)
  };
  const queue = [...relevant];
  for (const filename of configuration.fileNames) {
    const relative = path.relative(root, filename).replaceAll("\\", "/");
    if (snapshot.files.has(relative) && !relevant.has(relative)) { relevant.add(relative); queue.push(relative); }
  }
  while (queue.length) {
    const relative = queue.pop();
    if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(relative)) continue;
    let text = snapshot.files.get(relative)?.toString();
    if (text === undefined) continue;
    if (relative.endsWith(".vue")) {
      text = extractVueScript(text);
    }
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, path.join(root, relative), configuration.options, host).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const dependency = path.relative(root, resolved).replaceAll("\\", "/");
      if (!snapshot.files.has(dependency) || relevant.has(dependency)) continue;
      relevant.add(dependency);
      queue.push(dependency);
    }
  }
  for (const filename of ["tsconfig.json", "scripts/lib/discover-manager-url.mjs"]) if (snapshot.files.has(filename)) relevant.add(filename);
  const inventory = [...relevant].sort().map(filename => [filename, createHash("sha256").update(snapshot.files.get(filename)).digest("hex")]);
  return { ...snapshot, webDigest: createHash("sha256").update(JSON.stringify(inventory)).digest("hex") };
}

async function runNode(root, arguments_, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: root, windowsHide: true, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = bytes => { output = (output + bytes.toString()).slice(-32768); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("exit", (code, reason) => code === 0 && !reason ? resolve() : reject(new Error(`Isolated Web build failed (${code ?? reason}): ${output}`)));
  });
}

export async function buildIsolatedWebUpdate({ sourceRoot, packageRoot, workRoot, expectedInputDigest, signal, run = runNode }) {
  const snapshot = await captureAutomaticWebInputs(sourceRoot);
  if (expectedInputDigest && snapshot.webDigest !== expectedInputDigest) return { state: "superseded" };
  for (const name of ["package.json", "package-lock.json"]) {
    const baseline = await fs.readFile(path.join(packageRoot, name)).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const current = snapshot.files.get(name);
    if (baseline?.toString() !== current?.toString()) return { state: "requires_switch", reasons: [{ file: name, reason: "Web dependencies differ from the installed backend baseline." }] };
  }
  signal?.throwIfAborted();
  await fs.mkdir(workRoot, { recursive: true });
  if ((await fs.readdir(workRoot)).filter(name => name.startsWith("web-build-")).length >= 8) throw new Error("Isolated Web workspace retention limit reached; active code was not changed.");
  const workspace = await fs.mkdtemp(path.join(workRoot, "web-build-"));
  const root = path.join(workspace, "package");
  let success = false;
  try {
    await writeAutomaticSnapshot(root, snapshot);
    await fs.cp(path.join(packageRoot, "dist"), path.join(root, "dist"), {
      recursive: true,
      filter: async filename => {
        const relative = path.relative(path.join(packageRoot, "dist"), filename).replaceAll("\\", "/");
        if (relative === "web-patches" || relative.startsWith("web-patches/")) return false;
        if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error("Installed Web baseline contains a symbolic link.");
        return true;
      }
    });
    await fs.symlink(await fs.realpath(path.join(sourceRoot, "node_modules")), path.join(root, "node_modules"), "junction");
    for (const arguments_ of [
      ["node_modules/vue-tsc/bin/vue-tsc.js", "-p", "ribiwebgui/tsconfig.json", "--noEmit"],
      ["node_modules/vite/bin/vite.js", "build", "--config", "ribiwebgui/vite.config.ts"],
      ["scripts/sync-plugin-web-bundles.mjs"]
    ]) {
      signal?.throwIfAborted();
      await run(root, arguments_, signal);
    }
    const { buildWebPatch, verifyWebPatch } = await import(pathToFileURL(path.join(packageRoot, "dist/manager/webPatchCatalog.js")).href);
    const revision = await buildWebPatch(root, path.join(root, "dist/web-patches"));
    const directory = path.join(root, "dist/web-patches", revision);
    await verifyWebPatch(directory, revision);
    signal?.throwIfAborted();
    if (!await automaticInputsUnchanged(sourceRoot, snapshot)) return { state: "superseded" };
    success = true;
    return { state: "prepared", workspace, directory, revision, inputDigest: snapshot.webDigest, sourceDigest: snapshot.digest };
  } finally {
    if (!success) await removeIsolatedWebWorkspace(workRoot, workspace);
  }
}

export async function removeIsolatedWebWorkspace(workRoot, workspace) {
  const root = await fs.realpath(workRoot);
  const target = await fs.realpath(workspace);
  if (path.dirname(target) !== root || !path.basename(target).startsWith("web-build-")) throw new Error("Refusing to remove a path outside the isolated build owner.");
  const dependencyLink = path.join(target, "package/node_modules");
  const dependency = await fs.lstat(dependencyLink).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (dependency?.isSymbolicLink()) await fs.unlink(dependencyLink);
  await fs.rm(target, { recursive: true, force: true });
}
