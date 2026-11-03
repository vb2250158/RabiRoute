import assert from 'node:assert/strict';
import test from 'node:test';
import { historyChannels } from '../src/personaHistoryChannels';
import type { MessageEndpointCatalogEntry } from '../src/messageEndpoints/messageEndpointCatalog';
const endpoints=[{type:'napcat',title:'NapCat / OneBot',icon:'mdi-message-badge-outline'},{type:'speech',title:'语音消息端',icon:'mdi-microphone-message'},{type:'heartbeat',title:'定时触发',icon:'mdi-timer-outline'}] as MessageEndpointCatalogEntry[];
test('built-in delivery history stays available alongside configured endpoint names and icons',()=>{
  const channels=historyChannels({adapters:['speech','napcat','heartbeat','napcat'],chatCategories:['agent','panel','replies','aiui']},endpoints);
  assert.equal(channels.length,7);
  for(const endpoint of endpoints){const channel=channels.find(item=>item.adapter===endpoint.type)!;assert.equal(channel.label,endpoint.title);assert.equal(channel.icon,endpoint.icon);}
  assert.equal(channels.some(channel=>/全部|all/i.test(channel.id+channel.label)),false);
  assert.deepEqual(historyChannels({adapters:[],chatCategories:['agent','replies']}).map(row=>row.id),['chat:agent','chat:panel','chat:replies','endpoint:system']);
  assert.equal(historyChannels({adapters:['speech'],chatCategories:[]},endpoints).some(item=>item.adapter==='napcat'),false);
});
test('new plugin metadata and missing-plugin rows keep the original configured endpoint identity',()=>{
  const plugin={type:'example-plugin',title:'Example endpoint',icon:'mdi-star-outline'} as MessageEndpointCatalogEntry;
  assert.deepEqual(historyChannels({adapters:['example-plugin'],chatCategories:[]},[plugin]).filter(row=>row.adapter==='example-plugin'),[{id:'endpoint:example-plugin',adapter:'example-plugin',label:plugin.title,icon:plugin.icon}]);
  assert.equal(historyChannels({adapters:['missing-plugin'],chatCategories:[]}).find(row=>row.adapter==='missing-plugin')?.icon,'mdi-puzzle-outline');
});
