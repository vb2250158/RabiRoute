import test from 'node:test';
import assert from 'node:assert/strict';
import {queryRabiSearch} from './lib/query-rabi-search.mjs';

test('unified client discovers once, passes the remaining explicit budget and treats caller metadata as optional',async()=>{
  for(const metadata of [{},{agentType:'new-type'},{agentType:'new-type',id:'new-id'}]){
    const calls=[];const meta={managerBaseUrl:'http://127.0.0.1:12345',applicationGenerationId:'generation',managerInstanceId:'manager',health:{live:true,state:'healthy'}};
    const result=await queryRabiSearch({...metadata,budgetMs:9000,query:{q:'卧室 空调'},discovery:{explicit:meta.managerBaseUrl},fetch:async(url,options)=>{
      calls.push(new URL(url).pathname);if(new URL(url).pathname==='/meta')return Response.json(meta);
      const budget=Number(new URL(url).searchParams.get('budgetMs'));assert.ok(budget>3000 && budget<=9000);
      assert.equal(options.headers['x-rabiroute-agent-type'],metadata.id?'new-type':undefined);
      return Response.json({code:0,data:{...meta,items:[]}});
    }});assert.equal(result.code,0);assert.deepEqual(calls,['/meta','/api/search']);
  }
});
test('total budget includes the response body and terminates even an uncooperative reader',async()=>{
  const meta={managerBaseUrl:'http://127.0.0.1:12345',applicationGenerationId:'generation',managerInstanceId:'manager',health:{live:true,state:'healthy'}};
  await assert.rejects(queryRabiSearch({budgetMs:30,discovery:{explicit:meta.managerBaseUrl},fetch:async url=>new URL(url).pathname==='/meta'?Response.json(meta):{ok:true,json:()=>new Promise(()=>{})}}),/deadline/);
});
