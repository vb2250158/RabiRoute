import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const root=new URL('../../',import.meta.url);
const css=readFileSync(new URL('ribiwebgui/src/scrollbars.css',root),'utf8');
test('scrollbar styling targets internal app and teleported overlay surfaces without a document-root scrollbar rule',()=>{
  const tree=postcss.parse(css);
  tree.walkRules(rule=>{
    for(const selector of rule.selector.split(/,\n/))assert.match(selector.trim(),/^:where\(\.v-application, \.v-overlay-container\)/);
    assert.doesNotMatch(rule.selector,/\bhtml\b|\bbody\b|:root/);
  });
  assert.match(css,/--rr-scrollbar-size:\s*6px/);
  assert.match(css,/--rr-scrollbar-thumb:\s*color-mix\([^;]*var\(--rr-muted\)/);
  assert.match(css,/--rr-scrollbar-thumb-hover:\s*color-mix\([^;]*var\(--rr-text\)/);
  assert.match(css,/::-webkit-scrollbar-track[^}]*background:\s*transparent/s);
  assert.match(css,/@supports selector\(::-webkit-scrollbar\)[\s\S]*scrollbar-width:\s*auto/);
  assert.match(css,/@media \(forced-colors: active\)/);
});

test('the shared stylesheet owns native scrollbars and preserves xterm slider geometry',()=>{
  const styles=readFileSync(new URL('ribiwebgui/src/styles.css',root),'utf8');
  assert.match(styles,/@import "\.\/scrollbars.css"/);
  assert.doesNotMatch(styles,/scrollbar-width:/);
  const video=readFileSync(new URL('src/plugins/io.rabiroute.manager.video/web/pages/VideoPage.vue',root),'utf8');
  assert.doesNotMatch(video,/scrollbar-width:/);
  const tree=postcss.parse(css);
  tree.walkRules(rule=>{
    if(rule.selector.includes('.slider')&&!rule.selector.includes('::before'))rule.walkDecls(decl=>{
      assert.ok(!['height','width','top','left','right','bottom','transform'].includes(decl.prop),'xterm owns slider dimensions/position');
    });
  });
  assert.match(css,/slider::before\s*\{[^}]*pointer-events:\s*none/s);
});

test('actual terminal theme callback tracks effective palette changes and releases its observer without terminal business commands',()=>{
  const source=readFileSync(new URL('ribiwebgui/src/components/RemoteTerminalDialog.vue',root),'utf8');
  const script=parse(source).descriptor.scriptSetup!.content;
  const ast=ts.createSourceFile('terminal.ts',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const chosen=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='syncTerminalTheme'||ts.isExpressionStatement(node)&&/^(onMounted|onBeforeUnmount)\(/.test(node.getText(ast)));
  const code=ts.transpileModule(chosen.map(node=>node.getText(ast)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const calls:string[]=[],mounted:Array<()=>void>=[],unmounted:Array<()=>void>=[];
  let change!:()=>void,observed:any;
  const palette:Record<string,string>={'--rr-canvas':'#121a22','--rr-text':'#e9f2f7','--rr-accent-strong':'#88edef','--rr-on-accent-strong':'#042629'};
  const terminal={options:{theme:{}},dispose:()=>calls.push('dispose')};
  const observerClass=class{constructor(callback:()=>void){change=callback;}observe(node:unknown,options:unknown){observed={node,options};}disconnect(){calls.push('disconnect-theme');}};
  const element={};
  const state=new Function('terminal','getComputedStyle','document','MutationObserver','onMounted','onBeforeUnmount','refresh',
    'let disposed=false,revision=0,themeObserver;const stream={abort(){}},observer={disconnect(){}};'+code+';return {syncTerminalTheme};')
    (terminal,()=>({getPropertyValue:(key:string)=>palette[key]??''}),{documentElement:element},observerClass,(fn:()=>void)=>mounted.push(fn),(fn:()=>void)=>unmounted.push(fn),()=>calls.push('refresh'));
  state.syncTerminalTheme();assert.deepEqual(terminal.options.theme,{background:'#121a22',foreground:'#e9f2f7',cursor:'#e9f2f7',cursorAccent:'#121a22',selectionBackground:'#88edef',selectionForeground:'#042629'});
  mounted.forEach(fn=>fn());assert.equal(observed.node,element);
  assert.deepEqual(observed.options.attributeFilter,['style','data-rabiroute-theme','data-rabiroute-theme-resource']);
  palette['--rr-canvas']='#f6f8fb';palette['--rr-text']='#112033';palette['--rr-accent-strong']='#0b6f72';palette['--rr-on-accent-strong']='#ffffff';change();
  assert.deepEqual(terminal.options.theme,{background:'#f6f8fb',foreground:'#112033',cursor:'#112033',cursorAccent:'#f6f8fb',selectionBackground:'#0b6f72',selectionForeground:'#ffffff'});
  unmounted.forEach(fn=>fn());assert.equal(calls.filter(c=>c==='disconnect-theme').length,1);assert.equal(calls.filter(c=>c==='dispose').length,1);
  const retained=terminal.options.theme;palette['--rr-canvas']='#000000';change();assert.equal(terminal.options.theme,retained);
});
