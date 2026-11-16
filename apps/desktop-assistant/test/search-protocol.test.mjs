import test from 'node:test';import assert from 'node:assert/strict';
import {createSearchAgentProtocol,createSearchTextFilter} from '../src/search-protocol.mjs';
const native='<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n<｜｜DSML｜｜ parameter name="query" string="true">Rokid AIUI</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
test('WorkBuddy native search is bound to current request and declared read-only tool; markup never streams',()=>{
 const p=createSearchAgentProtocol();p.modelOptions({provider:'workbuddy-cli'},[{function:{name:'web_search'}}]);
 const action=p.parseDecision('I will search.\n'+native,'current-request');assert.equal(action.requestId,'current-request');assert.equal(action.name,'web_search');assert.deepEqual(action.arguments,{query:'Rokid AIUI'});
 const f=createSearchTextFilter(true);let visible='';for(const letter of 'I will search.\n'+native)visible+=f.push(letter);visible+=f.finish();assert.equal(visible,'I will search.\n');
 for(const invalid of [native.replace('web_search','Bash'),native+'trailing',native.replace('string="true"','string="false"'),native+native])assert.throws(()=>p.parseDecision(invalid,'r'),/TURN_DECISION_INVALID/);
 const plain=createSearchTextFilter(true);assert.equal(plain.push('Normal streaming reply'),'Normal streaming reply');
  const canonical=JSON.stringify({protocol:p.id,requestId:'r',kind:'tool',name:'web_search',arguments:{query:'q'}});
  assert.equal(p.canonicalAssistantOutput(canonical+'\n<user_query>invented search receipt</user_query>','r'),canonical);
  assert.throws(()=>p.parseDecision(canonical.replace('"r"','"stale"'),'r'),/TURN_DECISION_INVALID/);
});
test('native syntax is never normalized for an undeclared search or a different model provider',()=>{
 for(const [provider,tools] of [['workbuddy-cli',[]],['compatible',[{function:{name:'web_search'}}]]]){
  const p=createSearchAgentProtocol();p.modelOptions({provider},tools);if(provider==='workbuddy-cli')assert.throws(()=>p.parseDecision(native,'r'),/TURN_DECISION_INVALID/);else assert.notEqual(p.parseDecision(native,'r').kind,'tool');
 }
});
