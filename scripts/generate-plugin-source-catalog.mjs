import fs from "node:fs/promises";
import path from "node:path";
import { readPluginSourceIdentity } from "./lib/plugin-source-identity.mjs";

const root=process.cwd(), plugins=[];
for(const entry of (await fs.readdir(path.join(root,"src/plugins"),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
  if(!entry.isDirectory())continue;
  const directory=path.join(root,"src/plugins",entry.name);
  const identity=await readPluginSourceIdentity(directory);
  plugins.push({sourceId:identity.sourceId,directory:`src/plugins/${entry.name}`,ecosystem:identity.ecosystem,publicationName:identity.publicationName,versionFile:identity.versionFile});
}
const catalogFile=path.join(root,"plugins/source-catalog.json");
const catalogBytes=JSON.stringify({schemaVersion:1,generatedBy:"scripts/generate-plugin-source-catalog.mjs",plugins},null,2)+"\n";
if(await fs.readFile(catalogFile,"utf8").catch(error=>{if(error.code==="ENOENT")return "";throw error;})!==catalogBytes)await fs.writeFile(catalogFile,catalogBytes);
for(const filename of ["docs/plugin-source-layout.md","docs/plugin-source-layout_en.md"]) {
  let before;try{before=await fs.readFile(path.join(root,filename),"utf8");}catch(error){if(error.code==="ENOENT")continue;throw error;}
  const table="| Plugin | Source folder | Version authority |\n| --- | --- | --- |\n"+plugins.map(item=>{
    const base="https://github.com/vb2250158/RabiRoute/";
    return `| \`${item.sourceId}\` | [source](${base}tree/main/${item.directory}) | [${item.versionFile}](${base}blob/main/${item.directory}/${item.versionFile}) |`;
  }).join("\n")+"\n";
  const after=before.replace(/<!-- plugin-source-index -->[\s\S]*?<!-- \/plugin-source-index -->/,"<!-- plugin-source-index -->\n"+table+"<!-- /plugin-source-index -->");
  if(after!==before)await fs.writeFile(path.join(root,filename),after);
}
console.log(`Indexed ${plugins.length} plugin source folders and their authoritative version files.`);
