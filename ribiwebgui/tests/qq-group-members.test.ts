import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import type { QqGroupMember } from '../../src/shared/qqConversationHistory';

test('clearing member search restores every healthy member without losing roles or identities',()=>{
  const source=fs.readFileSync(new URL('../../src/plugins/io.rabiroute.manager.persona/web/components/QqGroupMembers.vue',import.meta.url),'utf8');
  const setup=parse(source).descriptor.scriptSetup!;
  const ast=ts.createSourceFile('members.ts',setup.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const body=ast.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getFullText(ast)).join('\n');
  const emitted=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const members:QqGroupMember[]=[{id:'3',name:'Member'},{id:'2',name:'Admin',role:'admin'},{id:'1',name:'Owner',role:'owner'}];
  const state=new Function('computed','ref','defineProps','defineEmits','useI18n',emitted+';return {search,visible};')(
    computed,ref,()=>({members,loading:false,error:''}),()=>()=>{},()=>({t:(value:string)=>value})
  ) as {search:Ref<string|null>;visible:ComputedRef<QqGroupMember[]>};
  state.search.value='Owner';assert.deepEqual(state.visible.value.map(row=>row.id),['1']);
  state.search.value=null;assert.deepEqual(state.visible.value.map(row=>row.id),['1','2','3']);
  state.search.value='not found';assert.deepEqual(state.visible.value,[]);
  state.search.value=null;assert.equal(state.visible.value.length,3);
  assert.deepEqual(members.map(row=>row.id),['3','2','1']);
});
