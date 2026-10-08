import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "vendor");
const destination = path.join(root, "dist", "vendor");
fs.mkdirSync(destination, { recursive: true });
for (const name of ["marked.esm.js", "MARKED-LICENSE.md"]) {
  fs.copyFileSync(path.join(source, name), path.join(destination, name));
}
