/** Each backend keeps its own admission, mutation policy and receipts. */
export async function combineToolBackends(backends) {
  const owners=new Map();
  try {
    for(const backend of backends) {
      if(!backend||!Array.isArray(backend.tools)||typeof backend.executeTool!=='function'||typeof backend.toolPolicy?.classify!=='function'||typeof backend.toolPolicy?.inspectOutcome!=='function')throw Error('ASSISTANT_TOOL_ADAPTER_INVALID');
      for(const tool of backend.tools){const name=tool.function?.name;if(!name||owners.has(name))throw Error('ASSISTANT_TOOL_NAME_CONFLICT');owners.set(name,backend)}
    }
  } catch(error){const results=await Promise.allSettled(backends.map(backend=>Promise.resolve().then(()=>backend?.dispose?.())));const failures=results.filter(value=>value.status==='rejected').map(value=>value.reason);if(failures.length)throw new AggregateError([error,...failures],'ASSISTANT_TOOL_COMPENSATION_FAILED');throw error}
  const owner=decision=>{const backend=owners.get(decision.name||decision.functionName);if(!backend)throw Error('ASSISTANT_TOOLS_UNAVAILABLE');return backend};
  return {instructions:backends.map(backend=>backend.instructions).filter(value=>typeof value==='string'&&value).join('\n\n'),tools:backends.flatMap(backend=>backend.tools),executeTool:event=>owner(event).executeTool(event),
    toolPolicy:{classify:decision=>owner(decision).toolPolicy.classify(decision),inspectOutcome:(result,decision)=>owner(decision).toolPolicy.inspectOutcome(result,decision)},
    async dispose(){const outcomes=await Promise.allSettled(backends.map(backend=>Promise.resolve().then(()=>backend.dispose?.())));const errors=outcomes.filter(value=>value.status==='rejected').map(value=>value.reason);if(errors.length)throw new AggregateError(errors,'ASSISTANT_TOOL_CLEANUP_FAILED')}
  };
}
