import fs from "node:fs";
import path from "node:path";

/** Resolve npm from the running Node installation; a service need not have npm on PATH. */
export function resolveNpmCli({ execPath = process.execPath, env = process.env, platform = process.platform, isFile = filename => { try { return fs.statSync(filename).isFile(); } catch { return false; } } } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const explicit = env.npm_execpath?.trim();
  if (explicit) {
    if (!paths.isAbsolute(explicit) || !isFile(explicit)) throw new Error("Configured npm CLI is not an existing absolute file.");
    return explicit;
  }
  const binaryDirectory = paths.dirname(execPath);
  const prefix = paths.dirname(binaryDirectory);
  const candidates = [
    paths.join(binaryDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    paths.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    paths.join(prefix, "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const found = candidates.find(isFile);
  if (!found) throw new Error("Node.js npm CLI is missing from the current Node installation; repair npm before updating this instance.");
  return found;
}
