import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileReceiptPolicy} from './rabilink-agent-profile-ui-receipt.mjs';
const policy=createProfileReceiptPolicy();
const profile={revision:2,id:'assistant',name:'Correct',systemPrompt:'',skills:[],mcp:[]};
const intent={idempotencyKey:'stable',expectedRevision:1,profile};
const receipt={idempotencyKey:'stable',savedRevision:2,profile,applied:null};
test('complete normalized profile required, wrong or incomplete 200 is not confirmation',()=>{
 assert.equal(policy.matches(receipt,intent),true);
 assert.equal(policy.matches({...receipt,profile:{revision:2,name:'WRONG'}},intent),false);
 assert.equal(policy.matches({...receipt,profile:{...profile,name:'WRONG'}},intent),false);
 assert.equal(policy.matches({...receipt,profile:{...profile,token:'secret'}},intent),false);
 const reordered={mcp:[],skills:[],systemPrompt:'',name:'Correct',id:'assistant',revision:2};
 assert.equal(policy.matches({...receipt,profile:reordered},intent),true);
});
test('applied fields and version fail closed',()=>{
 for(const applied of [{appliedRevision:3,status:'applied'},{appliedRevision:2,status:'failed'},undefined,{appliedRevision:2,status:'applied',errorCode:'APPLY_FAILED'}]) assert.equal(policy.matches({...receipt,applied},intent),false);
 assert.equal(policy.matches({...receipt,applied:{appliedRevision:1,status:'failed',errorCode:'APPLY_FAILED'}},intent),true);
});
test('historical receipt confirms old intent even after current profile advances',async()=>{
 const current={...profile,revision:3,name:'Newer'}; assert.notDeepEqual(current,profile);
 let calls=0; assert.equal(await policy.resolveHistorical(intent,async key=>{calls++;assert.equal(key,'stable');return {status:200,body:{code:0,data:{receipt}}};}),true); assert.equal(calls,1);
 for(const response of [{status:200,body:{code:0,data:{receipt:null}}},{status:404,body:{}},{status:200,body:{code:0,data:{receipt:{...receipt,idempotencyKey:'other'}}}}]) assert.equal(await policy.resolveHistorical(intent,async()=>response),false);
});
