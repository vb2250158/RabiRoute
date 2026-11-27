import { randomUUID, createHash } from "node:crypto";
import { cloneGraph, validateCanvas } from "./workbenchGraph.mjs";

/** Import is a data conversion; unresolved commands and checks are reported, never executed. */
export function importWorkbench(source, definition) {
  const sourceHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  if (source?.version === 2 && source.graph) {
    validateCanvas(source, definition);
    const { graph } = cloneGraph(source.graph, randomUUID);
    return { canvas: { ...structuredClone(source), id: randomUUID(), revision: 0, graph }, report: { format: "workbench@2", sourceHash, nodeCount: graph.nodes.length, gaps: [] } };
  }
  if (!Array.isArray(source?.nodes)) throw new Error("不支持的导入格式：需要工作台 v2 或含 nodes 的旧线性工作流。");
  const stages = {}, gaps = [], ids = new Map(), nodes = [];
  for (const row of source.nodes) {
    if (typeof row.id !== "string" || ids.has(row.id)) throw new Error("导入节点身份缺失或重复。");
    ids.set(row.id, randomUUID());
  }
  for (const [index, row] of source.nodes.entries()) {
    const kind = row.kind === "manual" ? "human" : row.kind === "cli" || row.kind === "shell" && Array.isArray(row.cmd) ? "command" : row.kind;
    if (!definition.capabilities[kind]?.executable) throw new Error(`不支持的导入节点类型：${row.kind}`);
    const id = ids.get(row.id), stage = row.stage || "未分组"; stages[stage] = (stages[stage] || 0) + 1;
    // Shell command strings, private installation paths and Agent fallback chains need explicit resolution.
    const config = { importedNodeId: row.id, parameterSchema: structuredClone(row.params||[]), parameterValues: {}, legacy: structuredClone(row) };
    // The operator's own note is review context, not execution input: keep it visible on the card
    // instead of leaving it only inside `legacy`, where no canvas surface reads it.
    const note = typeof row.note === "string" ? row.note.trim() : "";
    if (note) config.note = note;
    if (kind === "human") config.instructions = row.hint || row.note || "";
    else {
      config.unresolved = true;
      gaps.push({ nodeId: id, code: kind === "agent" ? "exact_agent_target_required" : "trusted_tool_and_argv_required" });
    }
    const expected = Array.isArray(row.expect) ? row.expect : row.expect ? [row.expect] : [];
    const outputs = Array.isArray(row.outputs) ? row.outputs : [];
    const requirements = expected.map((entry, number) => {
      const relative = typeof entry === "string" ? entry : entry.path;
      if (typeof relative !== "string" || relative.startsWith("/") || relative.includes(":") || relative.includes("\\") || relative.split("/").includes("..")) { gaps.push({ nodeId: id, code: "artifact_path_binding_required", source: relative }); return null; }
      return { key: `expect-${number + 1}`, root: "output", path: relative, type: "file", required: true, freshness: "produced" };
    }).filter(Boolean);
    if (!expected.length) gaps.push({ nodeId: id, code: "required_artifact_contract_missing" });
    if (row.context?.inputs || row.upstream) gaps.push({ nodeId: id, code: "data_input_mapping_required" });
    nodes.push({ id, kind, title: row.title || row.name || row.label || row.id, optional: Boolean(row.defaultOff), enabled: !row.defaultOff,
      gate: Boolean(row.gate) && row.gate !== "soft", config, requirements, artifacts: outputs.map((value, number) => ({ key: `output-${number + 1}`, imported: value })),
      layout: { x: index * 380, y: 0 }, importSource: { nodeId: row.id, stage } });
  }
  const edges = nodes.slice(1).map((node, index) => ({ id: randomUUID(), from: nodes[index].id, to: node.id,
    fromPort: "control", toPort: "control", condition: nodes[index].gate ? "success" : "completed", ...(nodes[index].optional && !nodes[index].gate ? { allowSkip: true } : {}) }));
  for (const node of nodes) if (node.optional && node.gate) gaps.push({ nodeId: node.id, code: "optional_gate_skip_semantics_required" });
  const canvas = { version: 2, id: randomUUID(), name: String(source.name || source.title || "导入工作流"), revision: 0,
    workspaceBindingKey: "", variables: [], graph: { nodes, edges, groups: Object.keys(stages).map(name => ({ id: randomUUID(), name, nodeIds: nodes.filter(node => node.importSource.stage === name).map(node => node.id) })) } };
  // Optional gates are retained as optional; their success dependencies remain unsatisfied when disabled.
  validateCanvas(canvas, definition);
  return { canvas, report: { format: "linear@1", sourceHash, nodeCount: nodes.length, edgeCount: edges.length, stages, defaultOffCount: nodes.filter(node => !node.enabled).length, gaps } };
}
export function exportLinear(canvas,source,definition) {
  const nodes = canvas.graph.nodes, edges = canvas.graph.edges;
  if (canvas.graph.groups.some(group => group.kind === "subcanvas") || edges.length !== Math.max(0, nodes.length - 1)) throw new Error("此图不能无损导出为线性工作流。");
  for (let i = 0; i < nodes.length - 1; i++) {
    const links = edges.filter(edge => edge.from === nodes[i].id);
    if (links.length !== 1 || links[0].to !== nodes[i + 1].id || links[0].condition !== (nodes[i].gate ? "success" : "completed")) throw new Error("此图包含旧线性格式无法表达的控制语义。");
  }
  if (nodes.some(node => !node.importSource || node.inputs?.length || !node.config.unresolved) || canvas.variables.length) throw new Error("此图包含旧格式无法完整表达的配置或数据依赖；请导出工作台定义。");
  const original=importWorkbench(source,definition);
  if(original.report.sourceHash!==canvas.importReport?.sourceHash)throw new Error("原始导入材料摘要不匹配。");
  const semantic=node=>JSON.stringify({source:node.importSource.nodeId,kind:node.kind,config:node.config,requirements:node.requirements,artifacts:node.artifacts,gate:node.gate,optional:node.optional,enabled:node.enabled});
  if(nodes.length!==original.canvas.graph.nodes.length || nodes.some((node,index)=>semantic(node)!==semantic(original.canvas.graph.nodes[index])))throw new Error("节点语义已变化，无法无损导出旧格式。");
  return structuredClone(source);
}
