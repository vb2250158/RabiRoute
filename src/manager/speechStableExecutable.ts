import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stickySpeechAuthority, awaitSpeechAuthority, type SpeechAuthorityGuard } from "./speechRequestAuthority.js";

/** Keep the Windows firewall executable identity stable across program releases. */
export async function prepareStableSpeechExecutable(source: string, installRoot: string, guard?: SpeechAuthorityGuard): Promise<string> {
  const authority = stickySpeechAuthority(guard);
  authority();
  const root = path.resolve(installRoot);
  if (root.startsWith("\\\\")) throw new Error("Speech executable requires a local installation");
  const directory = path.join(root, "runtime", "speech");
  await awaitSpeechAuthority(authority, () => fs.mkdir(directory, { recursive: true }));
  const canonicalRoot = await awaitSpeechAuthority(authority, () => fs.realpath(root));
  const canonicalDirectory = await awaitSpeechAuthority(authority, () => fs.realpath(directory));
  if (canonicalDirectory.toLowerCase() !== path.join(canonicalRoot, "runtime", "speech").toLowerCase()) {
    throw new Error("Speech runtime directory cannot redirect outside its installation");
  }
  const target = path.join(directory, "RabiSpeech.exe");
  const current = await awaitSpeechAuthority(authority, () => fs.lstat(target).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  }));
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error("Invalid speech runtime executable target");
  const bytes = await awaitSpeechAuthority(authority, () => fs.readFile(source));
  if (current && bytes.equals(await awaitSpeechAuthority(authority, () => fs.readFile(target)))) return target;
  const temporary = path.join(directory, `.speech-${randomUUID()}.partial`);
  try {
    // Keep handle cleanup independent of request authority, including denial after open.
    authority();
    const file = await fs.open(temporary, "wx");
    try {
      authority();
      await awaitSpeechAuthority(authority, () => file.writeFile(bytes));
      await awaitSpeechAuthority(authority, () => file.sync());
    } finally { await file.close(); }
    // Windows refuses replacement while the executable is running; never fall back
    // to another path, which would create a second firewall identity.
    await awaitSpeechAuthority(authority, () => fs.rename(temporary, target));
  } catch (error) {
    authority();
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
  authority();
  return target;
}
