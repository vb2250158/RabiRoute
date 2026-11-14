import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAgentOwner } from '../../../src/agentAdapters/deviceAgentOwner.ts';
import { createDeviceAgentOperations } from '../../../src/agentAdapters/deviceAgentOperations.ts';
import { ManagerPluginRouteRegistry } from '../../../src/manager/managerPluginRouteRegistry.ts';

// Real PC journal/HTTP handlers plus the production page adapter. Device auth,
// wx storage and model output are isolated fixtures; no installed Host is used.
const source=(await fs.readFile(new URL('../utils/device-agent-page.js',import.meta.url),'utf8'))
  .replace(/^import .*;\r?\n/gm,'').replace('export const deviceAgentPageMethods','const deviceAgentPageMethods')
  +'\nglobalThis.methods=deviceAgentPageMethods;';
for(const lost of ['before-submit','after-commit']) {
  test(`PC receipt recovery ${lost} resumes the next delivery without rerunning the original`,{timeout:15000},async()=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aiui-receipt-http-'));
    const owner=createDeviceAgentOwner({dataDir:directory,ownerInstanceId:'fixture-manager',
      authorize:request=>request.headers.authorization==='fixture-device'?{scope:'fixture',sourceDeviceId:'eye',deviceOwner:true}:null,
      authorizeDelivery:async request=>request.headers.authorization==='fixture-device'?{scope:'fixture'}:null,
      assertDeviceAssignment:async(scope,id)=>{assert.equal(scope,'fixture');assert.equal(id,'eye');}});
    const registry=new ManagerPluginRouteRegistry();
    const registration=registry.registerOperations('fixture-aiui-recovery',createDeviceAgentOperations(()=>owner));
    const server=http.createServer((request,response)=>{
      if(!registry.handle(request,new URL(request.url,'http://fixture.invalid'),response))response.writeHead(404).end();
    });
    const storage=new Map(),turns=[],posts=[];
    let page,failOnce=true;
    try {
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const base='http://127.0.0.1:'+server.address().port+'/api/device-agents/eye';
      const call=async(suffix,options={})=>{
        const response=await fetch(base+suffix,{method:options.method || 'GET',headers:{authorization:'fixture-device','content-type':'application/json'},
          ...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
        const body=await response.json();assert.equal(response.status<300,true,JSON.stringify(body));return body.data;
      };
      const session=(await call('/session',{method:'PUT',body:{sessionId:'native',name:'Fixture',loaded:true,capabilities:['language-model']}})).session;
      const state={config:{},context:{agentId:'eye',targetDeviceId:'pc'},scope:'fixture',sessionId:session.sessionId,ownerEpoch:session.ownerEpoch};
      const context=vm.createContext({Date,Math,Promise,setTimeout,clearTimeout,
        wx:{getStorageSync:key=>structuredClone(storage.get(key)),setStorageSync:(key,value)=>storage.set(key,structuredClone(value))},
        requestDeviceAgent:async(_config,_context,suffix,options)=>{
          if(suffix.endsWith('/response')) {
            posts.push(suffix);
            if(failOnce && suffix.includes('/first/')) {
              failOnce=false;
              if(lost==='after-commit')await call(suffix,options);
              throw Error('simulated transport loss');
            }
          }
          const result=await call(suffix,options);
          if(suffix==='/deliveries/second/response')page.pageVisible=false;
          return result;
        }});
      vm.runInContext(source,context);
      page={...context.methods,pageVisible:true,deviceAgentOwner:state,data:{},setData(value){Object.assign(this.data,value);},
        async executeLingzhuAgentPrompt(prompt){const name=prompt.includes('work-first')?'first':'second';turns.push(name);return {state:'completed',text:'result-'+name};}};
      const enqueue=id=>call('/deliveries',{method:'POST',body:{deliveryId:id,envelope:{deliveryId:id,sentAt:'2026-11-06T00:00:00Z',
        messageSource:{type:'system',eventType:'route',eventName:'Fixture delivery',eventId:id,routeId:'fixture-route'},messageContent:'work-'+id}}});
      await enqueue('first');await page.runDeviceAgentMailbox(state);
      assert.deepEqual(turns,['first']);
      assert.equal(storage.get('rabilink-aiui-device-agent-v1').executions['fixture|first'].state,'response-pending');
      assert.equal((await call('/deliveries/first')).receipt.status,lost==='before-submit'?'claimed':'completed');
      await enqueue('second');await page.runDeviceAgentMailbox(state);
      assert.deepEqual(turns,['first','second']);
      assert.equal(posts.filter(value=>value==='/deliveries/first/response').length,lost==='before-submit'?2:1);
      for(const id of ['first','second']) {
        const receipt=(await call('/deliveries/'+id)).receipt;
        assert.equal(receipt.status,'completed');assert.equal(receipt.response.text,'result-'+id);
        assert.equal(storage.get('rabilink-aiui-device-agent-v1').executions['fixture|'+id].state,'settled');
      }
    } finally {
      if(page)page.pageVisible=false;
      await registration.dispose();server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
      assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('aiui-receipt-http-'));
      await fs.rm(directory,{recursive:true,force:true});
    }
  });
}
