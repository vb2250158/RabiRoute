import assert from 'node:assert/strict';
import test from 'node:test';
import {qqMessageParts,qqStructuredMessageParts,storedQqParts} from '../../src/shared/qqMessageParts';
import {qqPartsPreview} from '../src/qqMessagePresentation';
import {qqForwardDisplayParts as qqDisplayParts,qqForwardPath,qqForwardUrl,qqForwardNodeUrl} from '../../src/plugins/io.rabiroute.manager.persona/web/persona/qqForwardPresentation';
const selection={routeId:'route-a',kind:'group' as const,target:'10001'};
test('merged forwards keep independent segment ordinals without exposing provider IDs or URLs',()=>{
 const value=[{type:'forward',data:{id:'provider-private-resource',url:'https://private.invalid/key'}},{type:'text',data:{text:'literal [CQ:forward,id=not-a-command]'}},{type:'image',data:{file:'private-path'}},{type:'forward',data:{id:'provider-private-resource'}}];
 const raw=qqStructuredMessageParts(value,'');
 assert.equal(raw[0].kind,'label','the Host/storage protocol remains unchanged');
 const parts=qqDisplayParts('',raw);
 assert.deepEqual(parts,[{kind:'forward',index:0},{kind:'text',text:'literal [CQ:forward,id=not-a-command]'},{kind:'media',mediaKind:'image',index:0,name:'图片'},{kind:'forward',index:1}]);
 assert.equal(JSON.stringify(parts).includes('private'),false);
 assert.equal(qqPartsPreview(raw),'[合并转发]literal [CQ:forward,id=not-a-command][图片][合并转发]');
 assert.deepEqual(qqDisplayParts('[CQ:forward,id=x][CQ:forward,id=x]',undefined),[{kind:'forward',index:0},{kind:'forward',index:1}]);
 assert.deepEqual(qqMessageParts('&#91;CQ:forward,id=x&#93;'),[{kind:'text',text:'[CQ:forward,id=x]'}]);
});
test('persisted forward parts and old labels remain readable without rewriting saved records',()=>{
 const stored=[{kind:'label' as const,text:'合并转发'},{kind:'text' as const,text:'body'},{kind:'label' as const,text:'合并转发'}];
 const before=JSON.stringify(stored);
 assert.deepEqual(qqDisplayParts('',stored),[{kind:'forward',index:0},{kind:'text',text:'body'},{kind:'forward',index:1}]);
 assert.equal(JSON.stringify(stored),before);
 assert.deepEqual(qqDisplayParts('[合并转发]',undefined),[{kind:'text',text:'[合并转发]'}]);
 assert.deepEqual(storedQqParts([{kind:'label',text:'合并转发'},{kind:'forward',index:0}]),[{kind:'label',text:'合并转发'}],'forward is only a display part, never a new persisted kind');
});
test('forward URLs remain rooted in the exact conversation, message, node and canonical depth',()=>{
 assert.equal(qqForwardPath(0),'0');
 assert.equal(qqForwardPath(1,{messageId:'-7',path:'0',nodeIndex:3}),'0.3.1');
 assert.equal(qqForwardPath(0,{messageId:'-7',path:'0.3.1',nodeIndex:99}),'0.3.1.99.0');
 assert.equal(qqForwardPath(0,{messageId:'-7',path:'0.3.1.99.0',nodeIndex:100}),'0.3.1.99.0.100.0');
 assert.equal(qqForwardPath(1000,{messageId:'-7',path:'0',nodeIndex:204}),'0.204.1000');
 assert.equal(qqForwardUrl(selection,-7,'0.3.1'),'/api/agent/qq/messages/-7/forwards/0.3.1?routeId=route-a&kind=group&target=10001');
 assert.equal(qqForwardNodeUrl(selection,{messageId:'-7',path:'0.3.1',nodeIndex:4}),'/api/agent/qq/messages/-7/forwards/0.3.1/nodes/4?routeId=route-a&kind=group&target=10001');
 for(const path of ['00','0.03.1','0.3','0.9007199254740992.1','0.3.9007199254740992','../0','0?url=x'])assert.equal(qqForwardUrl(selection,'-7',path),undefined);
 assert.equal(qqForwardUrl(selection,'../../message','0'),undefined);
 assert.equal(qqForwardNodeUrl(selection,{messageId:'-7',path:'0',nodeIndex:-1}),undefined);
});
