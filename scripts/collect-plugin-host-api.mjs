import fs from "node:fs/promises";
import path from "node:path";
import { readPluginSources } from "./lib/plugin-source-layout.mjs";

const root=process.cwd(), modules=new Set();
for (const {directory} of await readPluginSources(root)) {
  for (const name of ["runtime.build.json", "manager-runtime.build.json", "egress-runtime.build.json"]) {
    let specification;
    try { specification = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const item of specification.exports ?? []) if (item.hostModule) modules.add(item.hostModule);
  }
  async function visit(folder) {
    for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
      if (entry.isDirectory()) { if(!["web","node_modules","dist","data","logs"].includes(entry.name))await visit(path.join(folder,entry.name)); continue; }
      if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name) || entry.name.endsWith(".test.ts"))continue;
      const source=await fs.readFile(path.join(folder,entry.name),"utf8");
      for(const match of source.matchAll(/["']@rabiroute\/host-api\/([^"'\n]+)["']/g))modules.add(match[1]);
    }
  }
  await visit(directory);
}
const requested=[...modules].sort();
if(requested.some(id=>id.startsWith("plugins/")))throw new Error("A plugin implementation cannot be exported as a shared host contract: "+requested.filter(id=>id.startsWith("plugins/")).join(", "));
await fs.writeFile(path.join(root,"plugins/contracts/host-api/requested-modules.json"),JSON.stringify(requested,null,2)+"\n");
console.log(`Collected ${requested.length} shared host modules from actual plugin imports.`);
