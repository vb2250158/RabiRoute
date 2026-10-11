import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Directory existence is insufficient: interrupted pip installs leave it behind.
export const speechCoreDependencyFiles = [
  "fastapi/__init__.py", "uvicorn/__init__.py", "httpx/__init__.py",
  "python_multipart/__init__.py", "numpy/__init__.py", "scipy/__init__.py",
  "soundfile.py", "sounddevice.py"
];
export function speechRequirementsDigest(pluginRoot: string): string {
  return createHash("sha256").update(fs.readFileSync(path.join(pluginRoot, "requirements.txt"))).digest("hex");
}
export function speechDependenciesCurrent(pluginRoot: string, dependenciesRoot: string): boolean {
  try {
    return speechCoreDependencyFiles.every(file => fs.existsSync(path.join(dependenciesRoot, file)))
      && fs.readFileSync(path.join(dependenciesRoot, ".runtime-requirements.sha256"), "utf8").trim() === speechRequirementsDigest(pluginRoot);
  } catch { return false; }
}
export function packagedSpeechPython(packageRoot: string): string | undefined {
  const executable = path.join(packageRoot, "desktop-runtime", "python", "python.exe");
  return fs.existsSync(executable) ? executable : undefined;
}
