import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pluginSourceDirectory } from "./lib/plugin-source-layout.mjs";
import { readPluginSourceIdentity } from "./lib/plugin-source-identity.mjs";

async function writeVersionFiles(files, originals, updates) {
  for (let i=0;i<files.length;i++) if (await fs.readFile(files[i], "utf8") !== originals[i]) throw new Error("Plugin release inputs changed; retry from their current versions.");
  let written=0;
  try { for(;written<files.length;written++)await fs.writeFile(files[written],updates[written]); }
  catch(error) { for(let i=0;i<Math.min(written+1,files.length);i++)await fs.writeFile(files[i],originals[i]);throw error; }
}

/** Plugin releases update their own metadata and explicit profile references, never the host version. */
export async function bumpPluginVersion(root, packageId, version) {
  root = path.resolve(root);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Use a numeric semantic version.");
  const directory = pluginSourceDirectory(root, packageId);
  if (path.dirname(directory) !== path.join(root, "src/plugins")) throw new Error("Invalid plugin package ID.");
  const identity=await readPluginSourceIdentity(directory);
  const compare = (a,b) => { const x=a.split('.').map(Number), y=b.split('.').map(Number); for(let i=0;i<3;i++) if(x[i]!==y[i])return x[i]-y[i]; return 0; };
  if (compare(version, identity.version) <= 0) throw new Error("The new plugin version must increase.");
  if(identity.versionFile!=="rabi.plugin.json") {
    const files=[],originals=[],updates=[];
    for(const name of [...new Set([identity.versionFile,".codex-plugin/plugin.json",".codebuddy-plugin/plugin.json","rabi-plugin.json","plugin.json","package.json","package-lock.json"])]) {
      const file=path.join(directory,name);
      let bytes;try{bytes=await fs.readFile(file,"utf8");}catch(error){if(error.code==="ENOENT")continue;throw error;}
      const value=JSON.parse(bytes);
      if(value.version!==identity.version)throw new Error(`Plugin release versions disagree in ${name}.`);
      if(value.packages?.[""]?.version!==undefined && value.packages[""].version!==identity.version)throw new Error(`Plugin release versions disagree in ${name} root package.`);
      value.version=version;if(value.packages?.[""])value.packages[""].version=version;
      files.push(file);originals.push(bytes);updates.push(JSON.stringify(value,null,2)+"\n");
    }
    if(identity.ecosystem==="local-service") {
      const file=path.join(directory,"pyproject.toml");
      const bytes=await fs.readFile(file,"utf8");
      let inProject=false, found=false;
      const changed=bytes.replace(/^[^\r\n]+/gm,line=>{
        if(/^\s*\[/.test(line)) { inProject=/^\s*\[project\]\s*(?:#.*)?$/.test(line);return line; }
        if(!inProject)return line;
        return line.replace(/^(\s*version\s*=\s*)(["'])([^"'\r\n]+)\2(\s*(?:#.*)?)$/,(_whole,prefix,quote,before,suffix)=>{
          if(found)throw new Error("Service package declares more than one project version.");
          if(before!==identity.version)throw new Error("Service package and plugin release versions disagree.");
          found=true;
          return prefix+quote+version+quote+suffix;
        });
      });
      if(!found)throw new Error("Service package has no declared project version.");
      files.push(file);originals.push(bytes);updates.push(changed);
    }
    await writeVersionFiles(files,originals,updates);
    return {packageId,before:identity.version,version};
  }
  const files = [path.join(directory, "rabi.plugin.json"), path.join(directory, "package.json"), path.join(root, "plugins/profiles/desktop.json"), path.join(root, "plugins/profiles/package-migrations.json")];
  const originals = await Promise.all(files.map(file => fs.readFile(file, "utf8")));
  const [manifest, metadata, profile, migrations] = originals.map(bytes => JSON.parse(bytes));
  if (manifest.id !== packageId || metadata.name !== packageId || manifest.version !== metadata.version) throw new Error("Plugin version metadata is inconsistent.");
  const before = manifest.version;
  if (compare(version, before) <= 0) throw new Error("The new plugin version must increase.");
  manifest.version = metadata.version = version;
  for (const instance of profile.instances) if (instance.package === packageId && instance.version === before) instance.version = version;
  const migration = migrations.packages.find(item => item.packageId === packageId);
  if (migration && migration.toVersion === before) {
    migration.fromVersions = [...new Set([...migration.fromVersions, before])]; migration.toVersion = version;
  }
  const documents = [manifest, metadata, profile, migrations];
  await writeVersionFiles(files,originals,documents.map(value=>JSON.stringify(value,null,2)+"\n"));
  return { packageId, before, version };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [packageId, version] = process.argv.slice(2);
  if (!packageId || !version) throw new Error("Usage: node scripts/bump-plugin-version.mjs <package-id> <version>");
  console.log(JSON.stringify(await bumpPluginVersion(process.cwd(), packageId, version)));
}
