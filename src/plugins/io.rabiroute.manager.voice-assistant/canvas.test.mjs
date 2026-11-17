import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceAssistantOwner} from './src/runtime.mjs';

test('Rabi PC native plugin registers canvas, restores it within its persona and forwards it to the desktop presenter',async()=>{
 const stateRoot=await mkdtemp(join(tmpdir(),'rabi-pc-canvas-')),abort=new AbortController(),presentations=[];let modelStep=0,owner;
 const document={title:'PC fixture',nodes:[{kind:'rect',x:20,y:20,width:900,height:450,text:'Shared canvas'}]};
 const operations={async call(id,input){return{ok:true,data:{code:0,data:id==='manager.roles.list'?{roles:[{roleId:'A',title:'Persona A'}],nextCursor:null}:id==='manager.personas.resources.reference.read'?{document:'Persona A',personaConfig:{}}:{}}}},async describe(id){return{operation:{id,contract:{transport:'http',method:'GET',effects:{mode:'read'},request:{body:{kind:'none'}}}}}}};
 const args={identity:{applicationGenerationId:'fixture',managerInstanceId:'fixture-manager',activationId:'fixture-activation'},stateRoot,signal:abort.signal,publish(){},speech:{speechControl:{personas:()=>[],models:async()=>[]}},clientFactory:async()=>({operations,close:async()=>{}}),modelCatalog:async()=>[{id:'fixture',label:'fixture',isDefault:true}],
  deviceFactory:async()=>({configurePresenter:async()=>({visible:false}),present:async value=>{presentations.push(structuredClone(value));return true},close:async()=>{}}),
  createModel:()=>({async prompt(input){const value=JSON.parse(input[0].content);return modelStep++===0?JSON.stringify({protocol:value.protocol,requestId:value.requestId,kind:'tool',name:'assistant_canvas',arguments:{action:'show',persistent:true,document}}):'Drawn.'},destroy(){}})};
 try{
  owner=await createVoiceAssistantOwner(args);await owner.submit('draw','pc-canvas');
  for(let i=0;i<100&&(await owner.state()).context.busy;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await owner.state()).canvas.document.title,'PC fixture');assert.equal((await owner.state()).canvas.visible,true);
  assert.ok((await owner.messages()).some(message=>message.canvas?.document.title==='PC fixture'));
  await owner.command({action:'host-settings',patch:{personaId:'A'}});assert.equal((await owner.state()).canvas.visible,false);
  await owner.command({action:'host-settings',patch:{personaId:''}});assert.equal((await owner.state()).canvas.visible,true);
  for(let i=0;i<100&&!presentations.some(value=>value.canvas?.document?.title==='PC fixture');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(presentations.some(value=>value.canvas?.document?.title==='PC fixture'));
  await owner.command({action:'canvas-close'});assert.equal((await owner.state()).canvas.visible,false);
 }finally{await owner?.dispose();await rm(stateRoot,{recursive:true,force:true})}
});
