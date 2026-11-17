import {importWorkbench} from './workbenchImport.mjs';
import {validateCanvas} from './workbenchGraph.mjs';

/** Pure, explicit migration profile. It translates references and never grants execution permissions. */
export function resolveLinearWorkbench(source,definition,profile) {
 const converted=importWorkbench(source,definition), canvas=converted.canvas, gaps=[];
 const tokens=profile.tokens||{};
 const expand=value=>typeof value==='string'?value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(whole,key)=>Object.hasOwn(tokens,key)?tokens[key]:whole):value;
 const bySource=new Map(source.nodes.map(row=>[row.id,row]));
 canvas.name=profile.name||canvas.name;canvas.workspaceBindingKey=profile.workspaceBindingKey||'';canvas.variables=structuredClone(profile.variables||[]);
 for(const node of canvas.graph.nodes) {
  const row=bySource.get(node.importSource.nodeId),override=profile.nodes?.[row.id]||{};
  const base={importedNodeId:row.id,parameterSchema:structuredClone(row.params||[]),parameterValues:{},context:structuredClone(row.context||{}),todo:structuredClone(row.todo||[]),designs:structuredClone(row.designs||[])};
  if(node.kind==='command') {
   const toolKey=profile.executableMap?.[row.cmd?.[0]];
   if(!toolKey||!Array.isArray(row.cmd)||row.cmd.some(arg=>typeof arg!=='string'))gaps.push({nodeId:node.id,code:'trusted_tool_and_argv_required'});
   node.config={...base,toolKey:toolKey||'',argv:Array.isArray(row.cmd)?row.cmd.slice(1).map(expand):[],timeoutMs:(row.timeout||600)*1000,...override.config};
  } else if(node.kind==='agent')node.config={...base,agentBindingKey:override.agentBindingKey||row.id,...override.config};
  else node.config={...base,...override.config};
  if(node.kind==='agent'&&!node.config.briefRef)gaps.push({nodeId:node.id,code:'agent_brief_reference_required'});
  if(override.requirements)node.requirements=structuredClone(override.requirements);
  else node.requirements=node.requirements.map(requirement=>({...requirement,path:expand(requirement.path)}));
  if(override.inputs)node.inputs=structuredClone(override.inputs);
  if(override.parameterSchema)node.config.parameterSchema=structuredClone(override.parameterSchema);
  if(override.optional!==undefined)node.optional=override.optional;
  if(override.enabled!==undefined)node.enabled=override.enabled;
  if(override.gate!==undefined)node.gate=override.gate;
  if(override.resourceKey)node.resourceKey=expand(override.resourceKey);
  if(gaps.some(gap=>gap.nodeId===node.id))node.config.unresolved=true;
  const stageIndex=(source.stages||Object.keys(converted.report.stages)).indexOf(row.stage);
  const position=canvas.graph.nodes.filter(n=>n.importSource.stage===row.stage).indexOf(node);
  node.layout={x:Math.max(0,stageIndex)*440,y:position*160};
 }
 // Explicitly optional stages preserve linear skip-through while required data inputs still block consumers.
 for(const edge of canvas.graph.edges){const from=canvas.graph.nodes.find(n=>n.id===edge.from);if(from.optional){edge.condition='completed';edge.allowSkip=true;}}
 converted.report.gaps=gaps;converted.report.resolved=true;converted.report.nodeCount=canvas.graph.nodes.length;
 canvas.migration={sourceHash:converted.report.sourceHash,sourceNodeIds:source.nodes.map(row=>row.id),profileVersion:profile.version||1};
 const ids=new Map(canvas.graph.nodes.map(node=>[node.importSource.nodeId,node.id]));
 for(const node of canvas.graph.nodes){node.inputs=(node.inputs||[]).map(input=>input.producerSourceId?{producerNodeId:ids.get(input.producerSourceId),artifactKey:input.artifactKey}:input);if(node.config.independentFromSourceId){node.config.independentFromNodeId=ids.get(node.config.independentFromSourceId);delete node.config.independentFromSourceId;}}
 validateCanvas(canvas,definition);return converted;
}
