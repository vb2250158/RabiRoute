import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {VideoProjects} from './projects.mjs';
import {resolveWorkbenchBinding,resolveNodeParameters,expandRootReferences} from './workbenchBindings.mjs';

test('dated roots bind one edition without accepting path variables',()=>{
 const binding={roots:{runtime:os.tmpdir(),output:path.join(os.tmpdir(),'editions','${date}')}};
 const resolved=resolveWorkbenchBinding(binding,[{name:'date',type:'date',value:'2026-11-17'}]);
 assert.equal(resolved.roots.output,path.join(os.tmpdir(),'editions','2026-11-17'));
 assert.throws(()=>resolveWorkbenchBinding(binding,[{name:'date',type:'string',value:'../escape'}]),/未知变量/);
 assert.equal(expandRootReferences('{root:output}/file.json',resolved.roots),resolved.roots.output+'/file.json');
 assert.throws(()=>expandRootReferences('{root:secret}/file',{}),/未配置/);
});
test('typed parameters preserve source defaults and reject invalid overrides',()=>{
 const node={kind:'command',config:{argv:['run','--save'],parameterSchema:[{name:'save',type:'flag',default:false},{name:'workers',type:'number',min:1,max:8,default:2},{name:'limit',type:'number',kind:'check',default:4}],parameterValues:{}}};
 const resolved=resolveNodeParameters(node);assert.deepEqual(resolved.config.argv,['run','--save','--workers','2']);assert.deepEqual(resolved.config.resolvedChecks,{limit:4});assert.deepEqual(node.config.argv,['run','--save']);
 assert.throws(()=>resolveNodeParameters({...node,config:{...node.config,parameterValues:{workers:20}}}),/超出范围/);
 assert.throws(()=>resolveNodeParameters({...node,config:{...node.config,parameterValues:{unknown:'value'}}}),/未知/);
});
test('complete material import verifies content and rejects traversal and changed retry',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-bundle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const owner=new VideoProjects({stateRoot:root,machineId:'test'}),project=await owner.createProjectV2({id:randomUUID()});
 const source={version:2,name:'完整流程',workspaceBindingKey:'test',variables:[],graph:{nodes:[{id:'a',kind:'agent',config:{briefRef:{root:'canvas',path:'materials/brief.txt'}}}],edges:[],groups:[]}};
 const bytes=Buffer.from('任务书与参数'),item={path:'materials/brief.txt',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')},body={id:randomUUID(),source,materials:[item]};
 const result=await owner.importCanvas(project.id,body);assert.equal(result.importReport.materials.length,1);
 assert.deepEqual(await fs.readFile(path.join(owner.canvasDirectory(project.id,result.id),item.path)),bytes);
 assert.equal((await owner.importCanvas(project.id,body)).id,result.id);
 await assert.rejects(owner.importCanvas(project.id,{...body,materials:[{...item,base64:Buffer.from('changed').toString('base64'),sha256:undefined}]}),/不同内容/);
 await assert.rejects(owner.importCanvas(project.id,{...body,id:randomUUID(),materials:[{...item,path:'materials/../../escape'}]}),/相对路径/);
 await assert.rejects(owner.importCanvas(project.id,{...body,id:randomUUID(),materials:[{...item,sha256:'wrong'}]}),/摘要/);
});

test('linear migration retains soft gates, task references and producer identities',async()=>{
 const {resolveLinearWorkbench}=await import('./workbenchMigration.mjs');
 const definition=JSON.parse(await fs.readFile(new URL('./workbench-definition.json',import.meta.url),'utf8'));
 const source={name:'source',stages:['one'],nodes:[{id:'a',kind:'shell',cmd:['python','a.py'],gate:'soft',stage:'one',params:[{name:'n',type:'number',default:2}]},{id:'b',kind:'agent',cmd:[],gate:'hard',stage:'one'}]};
 const profile={workspaceBindingKey:'test',executableMap:{python:'python'},nodes:{a:{requirements:[{key:'file',root:'output',path:'a.json',freshness:'produced'}]},b:{config:{briefRef:{root:'canvas',path:'materials/brief.md'}},inputs:[{producerSourceId:'a',artifactKey:'file'}]}}};
 const {canvas,report}=resolveLinearWorkbench(source,definition,profile);
 assert.equal(canvas.graph.nodes[0].gate,false);assert.equal(canvas.graph.nodes[1].gate,true);assert.equal(canvas.graph.edges[0].condition,'completed');assert.equal(canvas.graph.nodes[1].inputs[0].producerNodeId,canvas.graph.nodes[0].id);assert.equal(canvas.graph.nodes[0].config.parameterSchema[0].name,'n');assert.deepEqual(report.gaps,[]);
});
