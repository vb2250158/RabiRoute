import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse, NodeTypes, type ElementNode } from '@vue/compiler-dom';
import { historyChannels } from '../src/personaHistoryChannels';
import type { MessageEndpointCatalogEntry } from '../src/messageEndpoints/messageEndpointCatalog';
const endpoints=[{type:'napcat',title:'NapCat / OneBot',icon:'mdi-message-badge-outline'},{type:'speech',title:'语音消息端',icon:'mdi-microphone-message'},{type:'heartbeat',title:'定时触发',icon:'mdi-timer-outline'}] as MessageEndpointCatalogEntry[];
test('built-in delivery history stays available alongside configured endpoint names and icons',()=>{
  const channels=historyChannels({adapters:['speech','napcat','heartbeat','napcat'],chatCategories:['agent','panel','replies','aiui']},endpoints);
  assert.equal(channels.length,8);
  for(const endpoint of endpoints){const channel=channels.find(item=>item.adapter===endpoint.type)!;assert.equal(channel.label,endpoint.title);assert.equal(channel.icon,endpoint.icon);}
  assert.equal(channels.some(channel=>/全部|all/i.test(channel.id+channel.label)),false);
  assert.deepEqual(historyChannels({adapters:[],chatCategories:['agent','replies']}).map(row=>row.id),['chat:agent','agent:sessions','chat:panel','chat:replies','endpoint:system']);
  assert.equal(historyChannels({adapters:['speech'],chatCategories:[]},endpoints).some(item=>item.adapter==='napcat'),false);
});
test('new plugin metadata and missing-plugin rows keep the original configured endpoint identity',()=>{
  const plugin={type:'example-plugin',title:'Example endpoint',icon:'mdi-star-outline'} as MessageEndpointCatalogEntry;
  assert.deepEqual(historyChannels({adapters:['example-plugin'],chatCategories:[]},[plugin]).filter(row=>row.adapter==='example-plugin'),[{id:'endpoint:example-plugin',adapter:'example-plugin',label:plugin.title,icon:plugin.icon}]);
  assert.equal(historyChannels({adapters:['missing-plugin'],chatCategories:[]}).find(row=>row.adapter==='missing-plugin')?.icon,'mdi-puzzle-outline');
});


test('channel tabs and accessible actions share one responsive sticky header', () => {
  const source = readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaMessageHistory.vue', import.meta.url), 'utf8');
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const template = baseParse(descriptor.template!.content);
  const root = template.children.find(node => node.type === NodeTypes.ELEMENT) as ElementNode;
  const elements = root.children.filter(node => node.type === NodeTypes.ELEMENT) as ElementNode[];
  const header = elements.find(node => node.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class' && prop.value?.content === 'history-channel-header'))!;
  assert.ok(header);
  const children = header.children.filter(node => node.type === NodeTypes.ELEMENT) as ElementNode[];
  assert.deepEqual(children.map(node => node.tag), ['v-tabs', 'div']);
  const actions = children[1].children.filter(node => node.type === NodeTypes.ELEMENT) as ElementNode[];
  assert.deepEqual(actions.map(node => node.tag), ['v-btn', 'v-btn', 'v-select']);
  const buttons = actions.filter(node => node.tag === 'v-btn');
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.equal(button.tag, 'v-btn');
    assert.ok(button.props.some(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.content === 'aria-label'));
  }
  assert.ok(buttons[1].props.some(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'if' && prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION && prop.exp.content === '!recordingOpen'));
  assert.ok(actions[2].props.some(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'else'));
  assert.ok(actions[2].props.some(prop => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.content === 'label'));
  assert.match(source, /history-channel-header\{[^}]*display:flex[^}]*top:var\(--v-layout-top, 0px\)/);
  assert.match(source, /history-channel-tabs\{[^}]*flex:1;min-width:0/);
  assert.match(source, /history-channel-action-label\{display:none/);
});
