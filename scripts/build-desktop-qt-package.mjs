import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const normalizedName = value => value.toLowerCase().replaceAll('_','-').replaceAll('.','-');
let kernel;
function packageKernel() { return kernel ??= (async()=>[await tsImport('../src/plugin-kernel/packageLoader.ts',import.meta.url),await tsImport('../src/plugin-kernel/manifest.ts',import.meta.url)])(); }
async function inventory(root, relative='') {
  const files=[];
  for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;
    const name=relative?`${relative}/${entry.name}`:entry.name,stat=await fs.lstat(path.join(root,name));
    if(stat.isSymbolicLink())throw Error('Qt resources must use the existing plain package tree: '+name);
    if(stat.isDirectory())files.push(...await inventory(root,name));
    else if(stat.isFile())files.push({path:name,size:stat.size});
    else throw Error('Unsupported Qt resource entry: '+name);
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

/** Package an existing verified desktop-runtime; no downloads, pip, GUI changes, or binary rebranding. */
export async function buildDesktopQtPackage({runtimeRoot,outputRoot,id='io.rabiroute.desktop.computer-qt',version,pythonVersion='3.10.11'}) {
  const source=path.resolve(runtimeRoot),output=path.resolve(outputRoot);
  const inside=(base,target)=>{const relative=path.relative(base,target);return !relative||!relative.startsWith('..')&&!path.isAbsolute(relative);};
  if(inside(source,output)||inside(output,source))throw Error('Qt resource output must be separate from its input runtime.');
  if(!/^\d+\.\d+\.\d+$/.test(pythonVersion))throw Error('The original portable Python version is required.');
  const [{hashPluginPackage},{parsePluginManifest}]=await packageKernel();
  const manifest=parsePluginManifest({schemaVersion:2,id,version,entries:{desktop:{execution:'declarative',resource:'./computer-qt.json'}},provides:['desktop.computer.presentation@1'],requires:[],optional:[],permissions:[]});
  await inventory(source); // Reuse the normal plain-tree input rule before copying; never follow reparse links.
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output);
  await fs.cp(source,path.join(output,'runtime'),{recursive:true,errorOnExist:true,force:false,filter:file=>!file.split(path.sep).includes('__pycache__')&&!file.endsWith('.pyc')});
  const files=await inventory(output),names=new Set(files.map(file=>file.path));
  const command='./runtime/python/python.exe',overlay='./runtime/rabiroute_tray/computer_control_overlay.py';
  for(const required of [command.slice(2),overlay.slice(2),'runtime/rabiroute_tray/theme.py','runtime/rabiroute_tray/themes/__init__.py',`runtime/python/python${pythonVersion.split('.').slice(0,2).join('')}._pth`])if(!names.has(required))throw Error('The original Qt runtime is incomplete: '+required);
  const dependencies=[];
  for(const file of files.filter(file=>/\.dist-info\/METADATA$/.test(file.path))){
    const text=await fs.readFile(path.join(output,file.path),'utf8'),name=text.match(/^Name:\s*(.+)$/m)?.[1]?.trim(),dependencyVersion=text.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
    if(!name||!dependencyVersion)throw Error('Qt distribution metadata is incomplete: '+file.path);
    dependencies.push({name,version:dependencyVersion,metadata:file.path});
  }
  for(const name of ['pyside6-essentials','shiboken6'])if(!dependencies.some(item=>normalizedName(item.name)===name))throw Error('Qt dependency metadata is missing: '+name);
  const notices=files.map(file=>file.path).filter(name=>/(?:^|\/)(?:licen[cs]es?|copying|notices?)(?:[./_-]|$)/i.test(name));
  if(!notices.length)throw Error('The original Qt runtime license/notice closure is missing.');
  const descriptor={schemaVersion:1,protocol:'rabi-computer-overlay-jsonl@1',platform:'win32-x64',command,overlay,python:{version:pythonVersion,source:'existing-verified-desktop-runtime'},dependencies,notices,files};
  await fs.writeFile(path.join(output,'rabi.plugin.json'),JSON.stringify(manifest,null,2)+'\n');await fs.writeFile(path.join(output,'computer-qt.json'),JSON.stringify(descriptor,null,2)+'\n');
  const revision=await hashPluginPackage(output);
  return Object.freeze({id:manifest.id,version:manifest.version,revision,outputRoot:output,files:files.length,dependencies:dependencies.length});
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const runtimeRoot=get('--runtime-root'),outputRoot=get('--output-directory'),version=get('--version');
  if(!runtimeRoot||!outputRoot||!version)throw Error('Usage: node scripts/build-desktop-qt-package.mjs --runtime-root <verified desktop-runtime> --output-directory <new resource package> --version <version> [--id <plugin id>] [--python-version <exact version>]');
  console.log(JSON.stringify(await buildDesktopQtPackage({runtimeRoot,outputRoot,version,id:get('--id'),pythonVersion:get('--python-version')})));
}
