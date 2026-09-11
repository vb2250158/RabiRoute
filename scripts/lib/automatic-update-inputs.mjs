import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const excluded = new Set([".git", "node_modules", "dist", ".web-patch-build.lock"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function captureAutomaticInputs(root, roots, limits = {}) {
  const files = new Map();
  const portable = new Set();
  const directories = new Set();
  const missing = [];
  let totalBytes = 0;
  const maximumBytes = limits.maximumBytes ?? 256 * 1024 * 1024;
  const maximumFiles = limits.maximumFiles ?? 16000;
  async function visit(relative) {
    if (!relative || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..") || path.isAbsolute(relative)) {
      throw new Error("Invalid automatic update input path.");
    }
    if (relative.split("/").some(part => excluded.has(part))) return;
    const filename = path.join(root, relative);
    const stat = await fs.lstat(filename).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) { missing.push(relative); return; }
    if (stat.isSymbolicLink()) throw new Error(`Automatic update input is a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      directories.add(relative);
      for (const name of (await fs.readdir(filename)).sort()) await visit(`${relative}/${name}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`Automatic update input is not a regular file: ${relative}`);
    if (files.has(relative)) return;
    if (portable.has(relative.toLowerCase())) throw new Error(`Automatic update paths collide: ${relative}`);
    if (stat.size > maximumBytes - totalBytes || files.size >= maximumFiles) throw new Error("Automatic update snapshot exceeds its input budget.");
    const bytes = await fs.readFile(filename);
    totalBytes += bytes.length;
    if (totalBytes > maximumBytes) throw new Error("Automatic update snapshot exceeds its input budget.");
    portable.add(relative.toLowerCase());
    files.set(relative, bytes);
  }
  for (const relative of [...new Set(roots)].sort()) await visit(relative);
  const inventory = [...files].map(([filename, bytes]) => [filename, hash(bytes)]).sort(([left], [right]) => left.localeCompare(right, "en"));
  const digest = hash(JSON.stringify({ files: inventory, directories: [...directories].sort(), missing: missing.sort() }));
  return { files, directories, digest, totalBytes, roots: [...roots] };
}

export async function automaticInputsUnchanged(root, snapshot) {
  return (await captureAutomaticInputs(root, snapshot.roots)).digest === snapshot.digest;
}

export async function writeAutomaticSnapshot(destination, snapshot) {
  await fs.mkdir(destination, { recursive: false });
  for (const relative of snapshot.directories) await fs.mkdir(path.join(destination, relative), { recursive: true });
  for (const [relative, bytes] of snapshot.files) {
    const filename = path.join(destination, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes, { flag: "wx" });
  }
}
