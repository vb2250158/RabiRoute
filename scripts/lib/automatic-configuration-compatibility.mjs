import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { assertDeveloperLocksCompatible } from "./developer-lock-compatibility.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function jsonObject(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("A configuration object is required.");
  return value;
}
function packageExecutionSettings(bytes) {
  const value = jsonObject(bytes);
  delete value.version;
  delete value.description;
  return value;
}
function compilerSettings(bytes) {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", bytes.toString("utf8"));
  if (parsed.error || !parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) throw new TypeError("The compiler configuration is invalid.");
  return parsed.config;
}

/** Only changed inputs need semantic comparison against the pinned installed bytes. */
export async function automaticConfigurationChangeReason(packageRoot, filename, expectedHash, candidateBytes) {
  if (typeof expectedHash !== "string" || !candidateBytes) {
    return "A compiler or package input was added or removed; a controlled switch is required.";
  }
  let baseline;
  try { baseline = await fs.readFile(path.join(packageRoot, filename)); }
  catch { return "The original installed configuration baseline is unavailable; equivalence cannot be established."; }
  if (hash(baseline) !== expectedHash) {
    return "The installed configuration baseline differs from the frozen catalog; equivalence cannot be established.";
  }
  try {
    if (filename === "package-lock.json") {
      // This project ships v3 locks. The existing verifier ignores only the
      // application/root package versions and compares the entire dependency graph.
      assertDeveloperLocksCompatible(baseline.toString("utf8"), candidateBytes.toString("utf8"));
      return undefined;
    }
    const project = filename === "package.json" ? packageExecutionSettings : compilerSettings;
    if (isDeepStrictEqual(project(baseline), project(candidateBytes))) return undefined;
  } catch {
    return "The pinned configuration and candidate do not establish equivalent execution dependencies; a controlled switch is required.";
  }
  return "Compiler or package execution settings changed; a controlled switch is required.";
}
