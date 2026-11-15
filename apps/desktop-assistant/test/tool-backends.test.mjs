import test from 'node:test';import assert from 'node:assert/strict';
import {combineToolBackends} from '../src/tool-backends.mjs';
import {createSearchAgentProtocol} from '../src/search-protocol.mjs';
const backend=(name,dispose=async()=>{})=>({tools:[{function:{name}}],executeTool:event=>event.functionName,toolPolicy:{classify:()=>({mutation:name==='write'}),inspectOutcome:result=>result},dispose});
test('combined tools retain each owner policy, result uncertainty, and joined disposal',async()=>{
 const disposed=[],one=backend('write',async()=>{disposed.push(1)}),two=backend('search',async()=>{disposed.push(2)}),all=await combineToolBackends([one,two]);
 assert.equal(all.toolPolicy.classify({name:'write'}).mutation,true);assert.equal(all.toolPolicy.classify({name:'search'}).mutation,false);assert.deepEqual(all.toolPolicy.inspectOutcome({uncertain:true,terminal:true},{name:'write'}),{uncertain:true,terminal:true});assert.equal(await all.executeTool({functionName:'search'}),'search');await all.dispose();assert.deepEqual(disposed,[1,2]);
});
test('duplicate tool declarations reject only after compensating both acquired backends; cleanup failures remain visible',async()=>{
 const disposed=[];await assert.rejects(combineToolBackends([backend('same',async()=>{await new Promise(resolve=>setTimeout(resolve,5));disposed.push(1)}),backend('same',async()=>{disposed.push(2);throw Error('cleanup')})]),error=>error instanceof AggregateError&&error.message==='ASSISTANT_TOOL_COMPENSATION_FAILED'&&error.errors.some(item=>item.message==='cleanup'));assert.equal(disposed.length,2);
});
test('WorkBuddy native operation calls are restricted to this declared tool set and canonical observations',()=>{
 const protocol=createSearchAgentProtocol();protocol.modelOptions({provider:'workbuddy-cli'},[{function:{name:'rabi_call'}}]);
 const raw='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="rabi_call"><｜｜DSML｜｜ parameter name="operation" string="true">manager.meta</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="input" string="false">{&quot;pathParams&quot;:{&quot;id&quot;:&quot;x&quot;}}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
 const value=protocol.parseDecision(raw,'request-1');assert.equal(value.name,'rabi_call');assert.deepEqual(value.arguments.input,{pathParams:{id:'x'}});assert.equal(value.requestId,'request-1');assert.throws(()=>protocol.parseDecision(raw.replace('rabi_call','undeclared'),'request-1'));
});
