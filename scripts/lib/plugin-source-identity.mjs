import fs from "node:fs/promises";
import path from "node:path";

/** Each ecosystem keeps its own authoritative manifest; the catalog records references, not copied version facts. */
export async function readPluginSourceIdentity(directory) {
  const sourceId=path.basename(directory);
  for(const file of ["rabi.plugin.json","rabi-plugin.json","package.json",".codex-plugin/plugin.json",".codebuddy-plugin/plugin.json","plugin.json"]) {
    let data;
    try { data=JSON.parse(await fs.readFile(path.join(directory,file),"utf8")); }
    catch(error) { if(error.code==="ENOENT")continue;throw error; }
    if(typeof data.version!=="string")continue;
    if(file==="rabi.plugin.json" && data.id!==sourceId)throw new Error(`Plugin source identity mismatch: ${sourceId}.`);
    return {sourceId,publicationName:data.id??data.name??sourceId,version:data.version,versionFile:file,
      ecosystem:file==="rabi.plugin.json"?"rabiroute":file.includes(".codex-plugin")?"codex":file.includes(".codebuddy-plugin")?"codebuddy":data.dsh?"dsh":data.napcat?"napcat":data.kind??"integration"};
  }
  throw new Error(`Plugin source has no versioned manifest: ${sourceId}.`);
}
