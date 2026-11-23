// Pure graph contracts are shared by persistence, execution and the web editor.
export class WorkbenchValidationError extends Error {}
const fail = message => { throw new WorkbenchValidationError(message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
export function relativeMaterialPath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":") || value.startsWith("/")
    || value.split("/").some(part => !part || part === "." || part === "..") || /[\x00-\x1f]/.test(value)) fail("材料路径必须是画布内的相对路径。");
  return value;
}
function unique(rows, label) {
  if (!Array.isArray(rows) || rows.length > 10000) fail(`${label}列表无效。`);
  const ids = new Set();
  for (const row of rows) {
    if (!object(row) || typeof row.id !== "string" || !row.id || row.id.length > 200 || ids.has(row.id)) fail(`${label}身份缺失或重复。`);
    ids.add(row.id);
  }
  return ids;
}
export function validateGraph(graph, definition) {
  if (!object(graph)) fail("画布图无效。");
  const ids = unique(graph.nodes, "节点"), edgeIds = unique(graph.edges, "边"), groupIds=unique(graph.groups, "分组");
  if(new Set([...ids,...edgeIds,...groupIds]).size!==ids.size+edgeIds.size+groupIds.size)fail("节点、边与分组的身份不能重复。");
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, []])), outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const node of graph.nodes) {
    if (!definition.capabilities[node.kind]) fail(`不支持的节点能力：${node.kind}`);
    if (!object(node.config)) fail(`节点 ${node.id} 缺少配置。`);
    const cli = node.config.cli;
    if (cli !== undefined && (node.kind !== "agent" || !object(cli) || !["workbuddy","codex"].includes(cli.provider)
      || Object.keys(cli).some(key=>key!=="provider" && key!=="model")
      || cli.model !== undefined && (typeof cli.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,119}$/.test(cli.model)))) fail("CLI 和模型选择无效。");
    if (node.textPreview !== undefined && (!object(node.textPreview) || typeof node.textPreview.attemptId !== "string"
      || typeof node.textPreview.text !== "string" || node.textPreview.text.length > 24000)) fail("文本预览无效。");
    if(node.config.independentFromNodeId&&!ids.has(node.config.independentFromNodeId))fail("独立核验节点引用无效。");
    if (node.gate && node.enabled === false && !node.optional) fail(`必须门禁 ${node.id} 不能禁用。`);
    if (node.layout && (!Number.isFinite(node.layout.x) || !Number.isFinite(node.layout.y))) fail("节点坐标无效。");
    if (node.template && !definition.templates.some(row => row.id === node.template.id && row.version === node.template.version)) fail("模板版本不可用。");
    if(node.requirements && !Array.isArray(node.requirements) || node.inputs && !Array.isArray(node.inputs)) fail("节点输入与产物要求必须是数组。");
    const requirementKeys=new Set();
    for (const requirement of node.requirements || []) {
      if (!object(requirement) || !requirement.key || !definition.freshness.includes(requirement.freshness)) fail("产物声明无效。");
      if(requirementKeys.has(requirement.key)) fail("产物声明 key 重复。");requirementKeys.add(requirement.key);
      relativeMaterialPath(requirement.path);
      if (requirement.minCount !== undefined && (!Number.isSafeInteger(requirement.minCount) || requirement.minCount < 1)) fail("产物最少数量无效。");
    }
    for (const input of node.inputs || []) {
      if (input.producerNodeId) {
        if (!ids.has(input.producerNodeId) || input.producerNodeId === node.id || typeof input.artifactKey !== "string") fail("数据输入引用无效。");
      } else if (!input.ref) fail("数据输入缺少来源。");
    }
  }
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (!from || !to || from === to) fail("边引用了缺失节点或自身。");
    if (!definition.edgeConditions.includes(edge.condition)) fail("不支持的边条件。");
    if (!definition.capabilities[from.kind].ports.out.includes(edge.fromPort) || !definition.capabilities[to.kind].ports.in.includes(edge.toPort)) fail("不支持的节点端口。");
    if (edge.allowSkip && (edge.condition !== "completed" || !from.optional)) fail("跳过只可传递到显式允许的可选顺序边。");
    incoming.get(edge.to).push(edge); outgoing.get(edge.from).push(edge);
  }
  for (const group of graph.groups) if (!Array.isArray(group.nodeIds) || group.nodeIds.some(id => !ids.has(id))) fail("分组引用无效。");
  // Data dependencies also participate in cycle detection, even without a control edge.
  const dependencies = new Map(graph.nodes.map(node => [node.id, new Set(incoming.get(node.id).map(edge => edge.from))]));
  for (const node of graph.nodes) for (const input of node.inputs || []) if (input.producerNodeId) dependencies.get(node.id).add(input.producerNodeId);
  const order = [], remaining = new Set(ids);
  while (remaining.size) {
    const next = [...remaining].find(id => [...dependencies.get(id)].every(parent => !remaining.has(parent)));
    if (!next) fail("画布存在循环依赖。");
    order.push(next); remaining.delete(next);
  }
  return { order, nodes, incoming, outgoing, edgeIds };
}
export function resolveLinkedText(cards, links, target) {
  const byId = new Map(cards.map(card => [card.id, card]));
  const incoming = new Map();
  for (const link of links) {
    const sources = incoming.get(link.to) ?? [];
    sources.push(link.from);
    incoming.set(link.to, sources);
  }
  const seen = new Set([target]);
  const text = [];
  function visit(id) {
    for (const source of incoming.get(id) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      const card = byId.get(source);
      if (card?.kind !== "text") continue;
      if (!card.generated) visit(source);
      if (typeof card.text === "string" && card.text.trim()) text.push(card.text.trim());
    }
  }
  visit(target);
  return text.join("\n\n");
}
function validateMediaLinks(value) {
  if (value.mediaLinks === undefined) return;
  if (!Array.isArray(value.mediaLinks) || value.mediaLinks.length > 2000) fail("内容连线列表无效。");
  const cards = new Map(value.graph.nodes.filter(node => node.config.legacyCardId).map(node => [node.config.legacyCardId, node.config.mediaKind]));
  for (const node of value.graph.nodes) {
    if (node.kind === "agent" && !node.config.legacyCardId) cards.set(node.id, node.config.textOutput === true ? "text" : "agent");
  }
  const dependencies = new Map([...cards.keys()].map(id => [id, new Set()]));
  for (const link of value.mediaLinks) {
    if (!object(link) || cards.get(link.from) !== "text" || link.from === link.to || !cards.has(link.to)) fail("内容连线需要一个文本来源和另一张卡片。");
    const inputs = dependencies.get(link.to);
    if (inputs.has(link.from)) fail("已经连接了这份内容。");
    inputs.add(link.from);
  }
  while (dependencies.size) {
    const ready = [...dependencies].filter(([, inputs]) => inputs.size === 0).map(([id]) => id);
    if (!ready.length) fail("内容连线不能形成循环。");
    for (const id of ready) dependencies.delete(id);
    for (const inputs of dependencies.values()) for (const id of ready) inputs.delete(id);
  }
}
export function validateCanvas(value, definition) {
  if (!object(value) || value.version !== 2 || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200) fail("画布名称或版本无效。");
  if (!Array.isArray(value.variables)) fail("画布变量无效。");
  const names = new Set();
  for (const row of value.variables) {
    if (!object(row) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name) || names.has(row.name) || !definition.variableTypes.includes(row.type)) fail("变量名称或类型无效。");
    names.add(row.name);
    if (row.type === "date" ? typeof row.value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.value) || !Number.isFinite(Date.parse(row.value)) || new Date(row.value).toISOString().slice(0, 10) !== row.value
      : typeof row.value !== row.type || row.type === "number" && !Number.isFinite(row.value)) fail(`变量 ${row.name} 的值无效。`);
  }
  const validated = validateGraph(value.graph, definition);
  validateMediaLinks(value);
  return validated;
}
export function expandVariables(value, variables) {
  const values = Object.fromEntries(variables.map(row => [row.name, row.value]));
  const expand = item => typeof item === "string" ? item.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name)) fail(`未知变量：${name}`); return String(values[name]);
  }) : Array.isArray(item) ? item.map(expand) : object(item) ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, expand(child)])) : item;
  return expand(value);
}
export function resolveTemplates(canvas,definition) {
  const result=structuredClone(canvas);
  for(const node of result.graph.nodes)if(node.template) {
    const template=definition.templates.find(row=>row.id===node.template.id&&row.version===node.template.version);
    if(!template||template.kind!==node.kind)fail("模板能力或版本不匹配。");
    node.config={...structuredClone(template.config||{}),...node.config};
    if(node.inputs===undefined&&template.inputs)node.inputs=structuredClone(template.inputs);
    if(node.requirements===undefined&&template.requirements)node.requirements=structuredClone(template.requirements);
  }
  result.definitionVersion=definition.version;return result;
}
export function cloneGraph(graph, allocate) {
  const copy = structuredClone(graph), ids = new Map();
  for (const row of [...copy.nodes, ...copy.edges, ...copy.groups]) { const old = row.id; row.id = allocate(); ids.set(old, row.id); }
  for (const edge of copy.edges) { edge.from = ids.get(edge.from); edge.to = ids.get(edge.to); }
  for (const group of copy.groups) group.nodeIds = group.nodeIds.map(id => ids.get(id));
  for (const node of copy.nodes) {
    for (const input of node.inputs || []) if (input.producerNodeId) input.producerNodeId = ids.get(input.producerNodeId);
    if(node.config.independentFromNodeId)node.config.independentFromNodeId=ids.get(node.config.independentFromNodeId);
    if(node.kind==="generate")delete node.config.jobId;
    // Execution receipts belong to the source canvas, never to its editable copy.
    delete node.jobId; delete node.attemptId; delete node.runId;
  }
  return { graph: copy, ids };
}
export function externalDependencies(canvas) {
  const found=new Map(),add=value=>found.set(JSON.stringify(value),value);
  if(canvas.workspaceBindingKey)add({type:"workspace-binding",key:canvas.workspaceBindingKey});
  for(const node of canvas.graph.nodes) {
    if(node.template)add({type:"template",id:node.template.id,version:node.template.version});
    if(node.config.assetId)add({type:"media-asset",id:node.config.assetId});
    if(node.config.toolKey)add({type:"tool",key:node.config.toolKey,workspaceBindingKey:canvas.workspaceBindingKey});
    if(node.config.target?.threadId)add({type:"agent-task",provider:node.config.target.agentAdapter,threadId:node.config.target.threadId});
    for(const ref of [...(node.inputs||[]).map(input=>input.ref),node.config.ref,node.config.briefRef].filter(Boolean))if(ref.root!=="canvas")add({type:"file-binding",root:ref.root,path:ref.path});
  }
  return [...found.values()];
}
