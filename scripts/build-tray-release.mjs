import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const manifestName = "tray-release.json";
const requiredFiles = ["main.py", "python/python.exe", "python/pythonw.exe"];

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

async function assertDirectoryPath(directory) {
  let existingParent;
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await lstatIfPresent(current);
    if (info && !info.isDirectory()) {
      throw new Error(`Expected a directory without links: ${current}`);
    }
    if (info && !existingParent) existingParent = current;
    if (path.dirname(current) === current) break;
  }
  if (!existingParent) throw new Error(`Directory volume does not exist: ${directory}`);
  return path.join(await fs.realpath(existingParent), path.relative(existingParent, directory));
}

async function payloadPaths(root, containsManifest = false) {
  const directories = [""];
  const files = [];
  const names = new Set();
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      const windowsName = relative.toLowerCase();
      if (names.has(windowsName) || /[<>:"\\|?*]/.test(entry.name) || /[ .]$/.test(entry.name)) {
        throw new Error(`Invalid or ambiguous Windows Tray path: ${relative}`);
      }
      names.add(windowsName);
      if (windowsName === manifestName) {
        if (containsManifest && relative === manifestName && entry.isFile()) continue;
        throw new Error(`Tray runtime contains reserved path: ${relative}`);
      }
      if (entry.isDirectory()) {
        directories.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new Error(`Tray runtime contains a link or unsupported file: ${relative}`);
      }
    }
  }
  return files.sort();
}

async function payloadManifest(root, paths) {
  const files = [];
  for (const relative of paths) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path.join(root, relative))) {
      hash.update(chunk);
      size += chunk.length;
    }
    files.push({ path: relative, size, sha256: hash.digest("hex") });
  }
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, "utf8");
}

async function verifyExistingRelease(releaseRoot, manifest) {
  await assertDirectoryPath(releaseRoot);
  const paths = await payloadPaths(releaseRoot, true);
  const recorded = await fs.readFile(path.join(releaseRoot, manifestName));
  if (!recorded.equals(manifest) || !(await payloadManifest(releaseRoot, paths)).equals(manifest)) {
    throw new Error(`Existing Tray release fails verification: ${releaseRoot}`);
  }
}

async function buildTrayRelease(desktopRuntime, outputRoot) {
  const runtimeRoot = path.resolve(desktopRuntime);
  const releasesRoot = path.resolve(outputRoot, "tray-releases");
  const inputPath = await assertDirectoryPath(runtimeRoot);
  const outputPath = await assertDirectoryPath(releasesRoot);
  if (isWithin(inputPath, outputPath) || isWithin(outputPath, inputPath)) {
    throw new Error("Tray release output must not overlap the desktop runtime input.");
  }
  const files = await payloadPaths(runtimeRoot);
  for (const required of requiredFiles) {
    if (!files.includes(required)) throw new Error(`Desktop runtime is missing ${required}.`);
  }

  await fs.mkdir(releasesRoot, { recursive: true });
  const staged = await fs.mkdtemp(path.join(releasesRoot, ".candidate-"));
  try {
    const directories = new Set(files.map(file => path.posix.dirname(file)));
    for (const directory of directories) {
      await fs.mkdir(path.join(staged, directory), { recursive: true });
    }
    for (const file of files) {
      await fs.copyFile(path.join(runtimeRoot, file), path.join(staged, file));
    }
    const manifest = await payloadManifest(staged, files);
    const digest = createHash("sha256").update(manifest).digest("hex");
    await fs.writeFile(path.join(staged, manifestName), manifest, { flag: "wx" });

    const releaseRoot = path.join(releasesRoot, digest);
    if (await lstatIfPresent(releaseRoot)) {
      await verifyExistingRelease(releaseRoot, manifest);
    } else {
      try {
        await fs.rename(staged, releaseRoot);
      } catch (error) {
        if (!(await lstatIfPresent(releaseRoot))) throw error;
        await verifyExistingRelease(releaseRoot, manifest);
      }
    }
    return { digest, releaseRoot, fileCount: files.length };
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: {
  "desktop-runtime": { type: "string" },
  "output-root": { type: "string" }
} });
if (!values["desktop-runtime"] || !values["output-root"]) {
  throw new Error("Usage: node scripts/build-tray-release.mjs --desktop-runtime <verified desktop runtime> --output-root <candidate state root>");
}
console.log(JSON.stringify(await buildTrayRelease(values["desktop-runtime"], values["output-root"])));
