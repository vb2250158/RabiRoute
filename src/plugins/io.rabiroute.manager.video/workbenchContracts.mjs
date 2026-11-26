import definition from "./workbench-definition.json" with { type: "json" };

// Stable response fields only. Graph, material, provider and receipt extensions
// stay owned by their existing validators; discovery does not strip them.
const object = properties => ({ type: "object", properties, additionalProperties: true });
const array = items => ({ type: "array", items });
const string = { type: "string" }, integer = { type: "integer" };
const opaque = { description: "Original owner field; retained unchanged and validated by that owner." };
const cursor = { type: ["string", "null"] };
const graph = object({ nodes: array(object({ id: string, kind: { enum: Object.keys(definition.capabilities) }, title: string, config: object({}), inputs: array(opaque), requirements: array(opaque), layout: object({}) })), edges: array(object({ id: string, from: string, to: string, condition: { enum: definition.edgeConditions } })), groups: array(opaque) });
const project = object({ version: { const: 2 }, id: string, title: string, revision: integer, updatedAt: string, defaultCanvasId: string, migration: object({ phase: { enum: ["prepared", "committed"] }, sourceRevision: integer, sourceHash: string, machineId: string }) });
const canvas = object({ version: { const: 2 }, id: string, name: string, revision: integer, updatedAt: string, workspaceBindingKey: string, variables: array(object({ name: string, type: { enum: definition.variableTypes }, value: opaque })), graph, externalDependencies: array(opaque), mediaEditor: object({ path: string, version: integer }), importReport: object({ gaps: array(opaque) }) });
const summary = object({ id: string, name: string, revision: integer, updatedAt: string, nodeCount: integer });
const attempt = object({ id: string, nodeId: string, title: string, state: { enum: Object.keys(definition.nodeStates) }, artifacts: array(opaque), receipt: opaque, error: string, approval: opaque, confirmation: opaque });
const run = object({ id: string, projectId: string, canvasId: string, projectRevision: integer, canvasRevision: integer, machineId: string, generation: string, state: { enum: Object.keys(definition.runStates) }, createdAt: string, updatedAt: string, snapshot: canvas, attempts: { type: "object", additionalProperties: attempt }, sequence: integer, concurrency: integer, resumedFromRunId: string });
const issues = array(object({ id: string, scope: string, code: string }));
const revision = object({ revision: integer });

export const workbenchResponses = Object.freeze({
  "workbench.definition": object({ version: integer, capabilities: { type: "object", additionalProperties: object({ label: string, executable: { type: "boolean" }, ports: object({ in: array(string), out: array(string) }) }) }, edgeConditions: array(string), variableTypes: array(string), freshness: array(string), templates: array(opaque), runStates: object({}), nodeStates: object({}) }),
  "workbench.cli-list": object({ providers: array(object({ id: string, label: string, installUrl: string,
    installed: { type: "boolean" }, ready: { type: "boolean" }, models: array(object({ id: string, label: string })) })) }),
  "workbench.projects-create": project,
  "workbench.project-read": project,
  "workbench.project-save": project,
  "workbench.project-migrate": project,
  "workbench.canvases-list": object({ canvases: array(summary), nextCursor: cursor }),
  "workbench.canvas-create": canvas,
  "workbench.canvas-copy": canvas,
  "workbench.canvas-import": canvas,
  "workbench.canvas-read": canvas,
  "workbench.canvas-thumbnail": object({ revision: integer, thumbnail: { anyOf: [{ type: "null" }, object({ viewBox: string, nodes: array(opaque), wires: array(string) })] } }),
  "workbench.canvas-export": { description: "Current Workbench canvas or the losslessly reconstructed original linear definition.", anyOf: [canvas, object({ nodes: array(opaque) })] },
  "workbench.canvas-save": canvas,
  "workbench.media-read": object({ revision: integer, title: string, value: { anyOf: [{ type: "null" }, object({ version: integer, items: array(opaque), drafts: array(opaque) })] } }),
  "workbench.media-save": revision,
  "workbench.index-rebuild": object({ count: integer }),
  "workbench.trigger-read": object({trigger:object({id:string,canvasId:string,runId:string,phase:string}),run}),
  "workbench.trigger": object({trigger:object({id:string,canvasId:string,runId:string,phase:string}),run}),
  "workbench.run-create": run,
  "workbench.runs-list": object({ runs: array(object({ id: string, projectId: string, canvasId: string, state: { enum: Object.keys(definition.runStates) }, createdAt: string, updatedAt: string })), nextCursor: cursor, recordIssues: issues }),
  "workbench.run-read": run,
  "workbench.run-refresh": run,
  "workbench.run-logs": object({ entries: array(object({ sequence: integer, nodeId: string, stream: string, text: string })), nextCursor: integer }),
  "workbench.run-cancel": run,
  "workbench.run-human": run
});
