import path from 'node:path';
import {expandVariables} from './workbenchGraph.mjs';

/** Trusted per-machine roots may vary by a validated date, never by an arbitrary path variable. */
export function resolveWorkbenchBinding(binding, variables) {
  const copy=structuredClone(binding), dates=variables.filter(row=>row.type==='date');
  for(const [key,value] of Object.entries(copy.roots||{})) {
    if(typeof value!=='string')throw new Error('目录绑定必须是字符串。');
    const result=expandVariables(value,dates);
    if(!path.isAbsolute(result))throw new Error('目录绑定必须是绝对路径。');
    copy.roots[key]=result;
  }
  return copy;
}
export function expandRootReferences(value, roots) {
  if(typeof value!=='string')return value;
  return value.replace(/\{root:([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,key)=>{
    if(!roots[key])throw new Error('未配置目录绑定：'+key);
    return roots[key];
  });
}
/** Parameters are data; check parameters retain their configuration reference rather than becoming unknown CLI flags. */
export function resolveNodeParameters(node) {
  const result=structuredClone(node), values=result.config.parameterValues||{}, schema=result.config.parameterSchema||[];
  if(!Array.isArray(schema)||!values||typeof values!=='object'||Array.isArray(values))throw new Error('节点参数定义无效。');
  const names=new Set(), checks={},checkOverrides={};
  for(const param of schema) {
    if(!param.name||names.has(param.name))throw new Error('节点参数身份重复或缺失。');names.add(param.name);
    const value=Object.hasOwn(values,param.name)?values[param.name]:param.default;
    if(value===undefined||value===null||value==='')continue;
    if(param.type==='flag' ? typeof value!=='boolean' : param.type==='number' ? typeof value!=='number'||!Number.isFinite(value) : typeof value!=='string')throw new Error('节点参数类型无效：'+param.name);
    if(param.options&&!param.options.includes(value)||param.min!==undefined&&value<param.min||param.max!==undefined&&value>param.max)throw new Error('节点参数超出范围：'+param.name);
    if(param.kind==='check'){checks[param.name]=value;if(Object.hasOwn(values,param.name)&&value!==param.default){if(!result.config.checkParameterSink)throw new Error('该工具尚未绑定阈值配置写入口：'+param.name);checkOverrides[param.name]=value;}continue;}
    if(result.kind!=='command')continue;
    const flag=param.flag||'--'+param.name;
    if(!/^--?[A-Za-z0-9_-]+$/.test(flag))throw new Error('节点参数 flag 无效。');
    const argv=result.config.argv;
    if(!Array.isArray(argv))throw new Error('命令参数必须是数组。');
    const index=argv.indexOf(flag);
    // An unchanged default must preserve the source command's explicit flag.
    if(!Object.hasOwn(values,param.name)&&index>=0)continue;
    if(index>=0)argv.splice(index,param.type==='flag'?1:2);
    if(param.type==='flag'){if(value)argv.push(flag);}else argv.push(flag,String(value));
  }
  for(const key of Object.keys(values))if(!names.has(key))throw new Error('未知节点参数：'+key);
  if(Object.keys(checks).length)result.config.resolvedChecks=checks;
  if(Object.keys(checkOverrides).length)result.config.checkOverrides=checkOverrides;
  return result;
}
