import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Keep the Windows firewall executable identity stable across program releases. */
export async function prepareStableSpeechExecutable(source: string, installRoot: string): Promise<string> {
  const root = path.resolve(installRoot);
  if (root.startsWith("\\\\")) throw new Error("Speech executable requires a local installation");
  const directory = path.join(root, "runtime", "speech");
  await fs.mkdir(directory, {recursive:true});
  if ((await fs.realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("Speech runtime directory cannot redirect outside its installation");
  const target = path.join(directory, "RabiSpeech.exe");
  const current = await fs.lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error("Invalid speech runtime executable target");
  const bytes = await fs.readFile(source);
  if (current && bytes.equals(await fs.readFile(target))) return target;
  const temporary = path.join(directory, `.speech-${randomUUID()}.partial`);
  try {
    const file = await fs.open(temporary, "wx");
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    // Windows refuses replacement while the executable is running; never fall back
    // to another path, which would create a second firewall identity.
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, {force:true}); }
  return target;
}
