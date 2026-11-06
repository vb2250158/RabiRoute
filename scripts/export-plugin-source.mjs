import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pluginSourceDirectory } from "./lib/plugin-source-layout.mjs";
import { copyPluginPublicSource } from "../plugins/contracts/plugin-sdk/public-source.mjs";
import { readPluginSourceIdentity } from "./lib/plugin-source-identity.mjs";

/** Export a reviewable repository source candidate; does not create or publish a GitHub repository. */
export async function exportPluginSource(root, packageId, output) {
  root = path.resolve(root);
  const source = pluginSourceDirectory(root, packageId);
  const manifest = await readPluginSourceIdentity(source);
  if (manifest.sourceId !== packageId || path.dirname(source) !== path.join(root,"src/plugins")) throw new Error("Invalid plugin source identity.");
  const target = path.resolve(output);
  const within=path.relative(root,target);
  const outside = within === ".." || within.startsWith(".." + path.sep) || path.isAbsolute(within);
  if (!outside) throw new Error("Export outside the working source tree.");
  try { await fs.lstat(target); throw new Error("Export destination already exists."); }
  catch(error) { if(error.code!=="ENOENT")throw error; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(target);
  await copyPluginPublicSource(source,target);
  await fs.copyFile(path.join(root,"LICENSE"),path.join(target,"LICENSE"));
  return { packageId,version:manifest.version,directory:target };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [packageId, output] = process.argv.slice(2);
  if (!packageId || !output) throw new Error("Usage: node scripts/export-plugin-source.mjs <package-id> <new-output-directory>");
  console.log(JSON.stringify(await exportPluginSource(process.cwd(),packageId,output)));
}
