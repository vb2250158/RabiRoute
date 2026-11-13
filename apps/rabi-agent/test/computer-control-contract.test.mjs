import assert from 'node:assert/strict';
import test from 'node:test';
import { instanceAgentActionDefinition, DEFAULT_COMPUTER_SETTINGS, COMPUTER_FEATURES, normalizeComputerSettings, patchComputerSettings, assertComputerActionEnabled, isComputerReadOnlyAction } from '../lib/computer-control-contract.mjs';
import { computerRequestSchema, computerResponseSchema } from '../lib/interactive-protocol.mjs';

test('computer defaults keep six public features enabled and dynamic annotation off', () => {
 const value=normalizeComputerSettings(); assert.equal(value.enabled,true);
 assert.deepEqual(Object.keys(value.features),Object.keys(COMPUTER_FEATURES)); assert.ok(Object.values(value.features).every(Boolean));
 assert.equal(value.control.idleTimeoutSeconds,120); assert.equal(value.control.exitShortcut,'Ctrl+Alt+Esc'); assert.equal(value.annotation.dynamicEnabled,false);
 assert.equal(value.annotation.staticDurationMs,10000); assert.equal(value.annotation.rateHz,10); assert.ok(Object.isFrozen(DEFAULT_COMPUTER_SETTINGS));
});
test('partial updates preserve explicit false, saved extensions and unrelated feature choices', () => {
 const saved=normalizeComputerSettings({enabled:false,features:{files:false,extensionFlag:false},control:{extension:{value:7}}});
 const next=patchComputerSettings(saved,{control:{showPointer:false}});
 assert.equal(next.enabled,false);assert.equal(next.features.files,false);assert.equal(next.features.terminal,true);assert.deepEqual(next.control.extension,{value:7}); assert.equal(next.features.extensionFlag,false);
 assert.notEqual(next.control,saved.control); assert.equal(saved.control.showPointer,true);
 assert.throws(()=>patchComputerSettings(next,{control:{idleTimeoutSeconds:0}})); assert.throws(()=>patchComputerSettings(next,{features:{files:'yes'}}));
});
test('disabled features reject new work while original receipts and cleanup remain accessible', () => {
 const off=normalizeComputerSettings({enabled:false});
 for(const action of ['file.read','screen.capture','control.begin','input.execute','annotation.show']) assert.throws(()=>assertComputerActionEnabled(off,action),{code:'COMPUTER_FEATURE_DISABLED'});
 for(const action of ['upload.status','upload.abort','control.status','control.end','input.status','input.cancel','annotation.status','annotation.clear','annotation.track.status','annotation.track.stop']) assert.doesNotThrow(()=>assertComputerActionEnabled(off,action));
 assert.throws(()=>assertComputerActionEnabled(DEFAULT_COMPUTER_SETTINGS,'annotation.track.start'),{code:'COMPUTER_DYNAMIC_DISABLED'});
 assert.doesNotThrow(()=>assertComputerActionEnabled(patchComputerSettings(DEFAULT_COMPUTER_SETTINGS,{annotation:{dynamicEnabled:true}}),'annotation.track.start'));
});
test('all thirteen declared desktop actions are discoverable and state reads remain read only', () => {
 const names=computerRequestSchema.anyOf.map(value=>value.properties.action.const);
 const expected=['control.begin','control.status','control.end','input.execute','input.status','input.cancel','annotation.show','annotation.update','annotation.status','annotation.clear','annotation.track.start','annotation.track.status','annotation.track.stop'];
 for(const name of expected)assert.equal(names.filter(value=>value===name).length,1,name);
 for(const name of ['control.status','input.status','annotation.status','annotation.track.status'])assert.equal(isComputerReadOnlyAction(name),true);
 assert.equal(isComputerReadOnlyAction('input.execute'),false); assert.ok(computerResponseSchema.anyOf.length>6);
});

// The default change must not silently increase a user's saved resource limit.
test('explicit memory budgets survive unrelated settings changes and discovery defaults', () => {
 const explicit=256*1024*1024;
 const saved=normalizeComputerSettings({performance:{memoryBudgetBytes:explicit},annotation:{dynamicEnabled:true}});
 assert.equal(saved.performance.memoryBudgetBytes,explicit);
 const changed=patchComputerSettings(saved,{control:{showPointer:false}});
 assert.equal(changed.performance.memoryBudgetBytes,explicit);
 assert.equal(changed.annotation.dynamicEnabled,true);
 assert.equal(normalizeComputerSettings().annotation.dynamicEnabled,false);
 assert.ok(normalizeComputerSettings().performance.memoryBudgetBytes>explicit);
});

test('action settings preserve unrelated bad data while validating only actual dependencies', async () => {
 const {normalizeComputerSettingsForAction}=await import('../lib/computer-control-contract.mjs');
 const raw={enabled:true,features:{files:true,input:true},annotation:{tracking:{matchThreshold:'broken'}},performance:{memoryBudgetBytes:'broken'},customExtension:{keep:1}};
 assert.throws(()=>normalizeComputerSettings(raw),/matchThreshold|memoryBudgetBytes/);
 const file=normalizeComputerSettingsForAction(raw,'file.stat');
 assert.equal(file.enabled,true); assert.equal(file.customExtension.keep,1);
 assert.equal(file.annotation.tracking.matchThreshold,'broken');
 assert.doesNotThrow(()=>normalizeComputerSettingsForAction(raw,'control.begin'));
 assert.throws(()=>normalizeComputerSettingsForAction(raw,'annotation.track.start'),/matchThreshold|memoryBudgetBytes/);
 assert.throws(()=>assertComputerActionEnabled({...raw,enabled:false},'file.stat'),error=>error.code==='COMPUTER_FEATURE_DISABLED');
});

test('DSBot action classification guards only new work and preserves catalog and original receipt recovery', () => {
 assert.deepEqual(instanceAgentActionDefinition('threads',{action:'ds_bot_deliver'}),{newWork:true,reconcileAction:'ds_bot_reconcile'});
 for(const action of ['ds_bot_catalog','ds_bot_reconcile']) assert.deepEqual(instanceAgentActionDefinition('threads',{action}),{readOnly:true,recovery:true});
});

test('saved return settings default true and display enumeration stays read only', async () => {
 const {computerActionDefinition}=await import('../lib/computer-control-contract.mjs');
 assert.equal(DEFAULT_COMPUTER_SETTINGS.control.returnCursor,true);assert.equal(DEFAULT_COMPUTER_SETTINGS.control.returnForeground,true);
 assert.equal(DEFAULT_COMPUTER_SETTINGS.presentation.barPlacement,'top-center');assert.equal(DEFAULT_COMPUTER_SETTINGS.presentation.noticeDurationMs,2500);
 assert.deepEqual(computerActionDefinition('displays.list'),{capability:'screenshots',feature:'observation',readOnly:true});
 assert.equal(isComputerReadOnlyAction('displays.list'),true);
});

test('foreground return confirmation has a visible configurable budget and preserves immediate mode', async () => {
 const {BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION:definition,normalizeComputerSettingsForAction}=await import('../lib/computer-control-contract.mjs');
 const field=definition.schema.properties.control.properties.returnForegroundTimeoutMs;
 assert.equal(field.type,'number');assert.equal(field.minimum,0);assert.equal(field.default,120);
 assert.equal(DEFAULT_COMPUTER_SETTINGS.control.returnForegroundTimeoutMs,120);
 for(const milliseconds of [0,1,1.5,120,5000]) {
  const saved=patchComputerSettings(DEFAULT_COMPUTER_SETTINGS,{control:{returnForegroundTimeoutMs:milliseconds}});
  assert.equal(normalizeComputerSettingsForAction(saved,'input.execute').control.returnForegroundTimeoutMs,milliseconds);
 }
 for(const invalid of [-1,'120',NaN])assert.throws(()=>patchComputerSettings(DEFAULT_COMPUTER_SETTINGS,{control:{returnForegroundTimeoutMs:invalid}}));
});
test('capture normalization preserves legacy selection and rejects every conflicting selector', async () => {
 const {normalizeComputerCaptureSpec:normalize}=await import('../lib/interactive-protocol.mjs');
 assert.deepEqual(normalize({}),{scope:'virtual'});assert.deepEqual(normalize({windowId:'abc',pid:42}),{scope:'window',windowId:'abc',pid:42});
 const region={x:0,y:4,width:100,height:80};
 assert.deepEqual(normalize({scope:'region',displayId:'left',region,source:{region:{height:80,width:100,y:4,x:0}}}),{scope:'region',displayId:'left',region});
 for(const [input,field] of [[{scope:'display'},'displayId'],[{scope:'region',displayId:'left',region:{...region,x:-1}},'region.x'],[{scope:'virtual',displayId:'left'},'displayId'],[{scope:'display',displayId:'a',source:{displayId:'b'}},'displayId'],[{scope:'display',displayId:'left',region},'region'],[{windowId:'abc'},'pid'],[{scope:'window',windowId:'abc',pid:42,captureSpec:{scope:'virtual'}},'scope']]) assert.throws(()=>normalize(input),error=>error.code==='COMPUTER_CAPTURE_INVALID'&&error.field===field);
});
