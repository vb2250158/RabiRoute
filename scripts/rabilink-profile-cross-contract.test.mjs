import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createProfileReceiptPolicy} from './rabilink-agent-profile-ui-receipt.mjs';
import {validateAgentProfile as relayValidate} from './rabilink-agent-profile.mjs';
// Load the pure QuickJS policy without changing the AIUI package module mode.
const source=await readFile(new URL('../apps/rabilink-aiui/utils/agent-profile.js',import.meta.url),'utf8');
const {validateAgentProfile:aiuiValidate}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const validators={phone:createProfileReceiptPolicy().profile,relay:relayValidate,aiui:aiuiValidate};
const skill=(id='skill-1',content='指引')=>({id,title:'标题',content,enabled:true});
const base=()=>({revision:1,id:'assistant',name:'助手',systemPrompt:'',skills:[skill()],mcp:[{id:'rabi-knowledge',label:'知识',enabled:true}]});
const cases=[];
const add=(name,expected,mutate)=>{const value=base();mutate?.(value);cases.push({name,expected,value});};
add('enabled Skill',true);
add('disabled Skill',true,p=>p.skills[0].enabled=false);
add('empty lists',true,p=>{p.skills=[];p.mcp=[];});
for(const n of [16,17])add(`Skill count ${n}`,n===16,p=>p.skills=Array.from({length:n},(_,i)=>skill('s'+i)));
for(const n of [8000,8001])add(`content UTF-16 units ${n}`,n===8000,p=>p.skills[0].content='x'.repeat(n));
for(const n of [24000,24001])add(`total content ${n}`,n===24000,p=>{p.skills=[skill('a','x'.repeat(8000)),skill('b','x'.repeat(8000)),skill('c','x'.repeat(8000))];if(n>24000)p.skills.push(skill('d','x'));});
add('duplicate Skill ID',false,p=>p.skills.push(skill()));
add('prototype-like legal IDs remain ordinary IDs',true,p=>p.skills=[skill('constructor'),skill('toString')]);
add('duplicate prototype-like ID rejected',false,p=>p.skills=[skill('constructor'),skill('constructor')]);
add('leading underscore ID rejected',false,p=>p.skills[0].id='__proto__');
add('empty title',false,p=>p.skills[0].title='');
add('whitespace title',false,p=>p.skills[0].title='  ');
add('null title',false,p=>p.skills[0].title=null);
add('null skill',false,p=>p.skills=[null]);
add('nonboolean enabled',false,p=>p.skills[0].enabled='false');
add('numeric enabled',false,p=>p.skills[0].enabled=0);
add('extra Skill field',false,p=>p.skills[0].command='forbidden');
add('extra profile field',false,p=>p.token='fixture-not-a-credential');
add('extra MCP field',false,p=>p.mcp[0].url='https://example.invalid');
add('missing enabled',false,p=>delete p.skills[0].enabled);
add('null list',false,p=>p.skills=null);
add('empty content allowed',true,p=>p.skills[0].content='');
add('nul content',false,p=>p.skills[0].content='a\u0000b');
for(const n of [128,129])add(`title BMP units ${n}`,n===128,p=>p.skills[0].title='汉'.repeat(n));
for(const n of [64,65])add(`title astral codepoints ${n}`,n===64,p=>p.skills[0].title='😀'.repeat(n));
for(const n of [4000,4001])add(`content astral codepoints ${n}`,n===4000,p=>p.skills[0].content='😀'.repeat(n));
add('combining marks count as UTF-16 units',true,p=>p.skills[0].content='e\u0301'.repeat(4000));
add('combining marks overflow',false,p=>p.skills[0].content='e\u0301'.repeat(4000)+'e');
add('unpaired surrogate follows existing JSON contract',true,p=>p.skills[0].content='\ud800');
add('Unicode ID rejected',false,p=>p.skills[0].id='技能');
for(const n of [16,17])add(`MCP count ${n}`,n===16,p=>p.mcp=Array.from({length:n},(_,i)=>({id:'m'+i,label:'M',enabled:false})));
add('duplicate MCP ID',false,p=>p.mcp.push({...p.mcp[0]}));
add('invalid MCP boolean',false,p=>p.mcp[0].enabled=null);
add('revision zero',false,p=>p.revision=0);
add('fractional revision',false,p=>p.revision=1.5);
for(const n of [8000,8001])add(`system prompt ${n}`,n===8000,p=>p.systemPrompt='x'.repeat(n));
cases.push({name:'null profile',expected:false,value:null});
// Additional MCP preservation cases: acceptance is not connectivity or authorization.
add('MCP preservation: unknown enabled reference',true,p=>p.mcp=[{id:'unknown-service',label:'Unknown label',enabled:true}]);
add('MCP preservation: known disabled label',true,p=>p.mcp=[{id:'rabi-knowledge',label:'Custom disabled label',enabled:false}]);
add('MCP preservation: empty label rejected',false,p=>p.mcp[0].label='');
add('MCP preservation: label 129 rejected',false,p=>p.mcp[0].label='x'.repeat(129));
for(const field of ['url','token','command'])add(`MCP preservation: extra ${field} rejected`,false,p=>p.mcp[0][field]='synthetic-forbidden-value');
add('MCP preservation: unknown and known retain order',true,p=>p.mcp=[{id:'unknown-service',label:'First',enabled:true},{id:'rabi-knowledge',label:'Second',enabled:false}]);
for(const {name,expected,value} of cases)test(`cross-contract: ${name}`,()=>{
 const outputs=[];
 for(const [side,validate] of Object.entries(validators)){
  // The HTTP boundary is JSON: every implementation receives an independent JSON value.
  const input=JSON.parse(JSON.stringify(value));let accepted=false,result;
  try{result=validate(input);accepted=true;}catch{}
  assert.equal(accepted,expected,`${side} acceptance differs for ${name}`);
  if(accepted)outputs.push(result);
 }
 if(expected){assert.deepEqual(outputs[0],outputs[1]);assert.deepEqual(outputs[1],outputs[2]);if(name.startsWith('MCP preservation:'))for(const output of outputs)assert.deepEqual(output,value,'MCP references must preserve label, enabled state and order');}
});
