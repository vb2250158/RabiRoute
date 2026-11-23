import fs from "node:fs/promises";
import { prepareLinearRunEvidence } from "./workbenchRunEvidence.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { VideoError } from "./service.mjs";
import { validateCanvas, expandVariables,resolveTemplates,resolveLinkedText } from "./workbenchGraph.mjs";
import { fingerprint, inspectRequirements, validateArtifacts, ownedFile } from "./workbenchArtifacts.mjs";
import definition from "./workbench-definition.json" with {type:"json"};
import {openMedia} from "./media.mjs";
import {triggerWorkbench} from "./workbenchTriggers.mjs";
import {resolveWorkbenchBinding, expandRootReferences, resolveNodeParameters} from "./workbenchBindings.mjs";
import {createWorkbenchCliCatalog, readCliEvent} from "./workbenchCli.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminalRuns = new Set(Object.entries(definition.runStates).filter(([,row])=>row.terminal).map(([state])=>state));
const timestamp = () => new Date().toISOString();
const missing = error => { if (error.code === "ENOENT") return undefined; throw error; };

function agentEndpoint(node, binding, key, requiredField) {
  const configured = node?.config[key];
  return configured?.[requiredField] ? configured : binding.agents?.[node?.config.agentBindingKey]?.[key];
}
const agentTarget = (node, binding) => agentEndpoint(node, binding, "target", "threadId");
const agentSource = (node, binding) => agentEndpoint(node, binding, "source", "sourceThreadId");

function provenUnsentAgentReceipt(attempt, receipt, state) {
  const result = attempt.acceptance;
  const { delivery, error, communication } = result?.data ?? {};
  return result?.statusCode === 503 && error?.stage === "target_verification" &&
    delivery?.status === "prepared" && delivery.retryable === true &&
    receipt?.state === state && receipt.request?.status === "pending_delivery" &&
    Boolean(receipt.deliveryId && receipt.request.id) &&
    receipt.deliveryId === delivery.deliveryId && receipt.request.id === communication?.requestId;
}

function preparedAgentCanRetry(attempt, receipt) {
  return provenUnsentAgentReceipt(attempt, receipt, "prepared");
}

/** One published plugin activation owns graph execution. Process/Agent/media owners retain their receipts. */
export class WorkbenchRuns {
  constructor(runtime, projects, media, publish) {
    this.runtime = runtime; this.projects = projects; this.media = media; this.publish = publish;
    this.root = runtime.workbenchRuntimeRoot; this.runs = new Map(); this.flights = new Map(); this.repump = new Set(); this.writes=new Map(); this.logWrites=new Map(); this.mediaWaiters=new Map(); this.processes = new Map(); this.releases = new Map(); this.serial = Promise.resolve(); this.closing = false;
    this.recordIssues=[]; this.agentEventStream=undefined; this.agentEventFlight=undefined;
    this.agentRetryRequests = new Set();
    this.cli = runtime.workbenchCli ?? createWorkbenchCliCatalog({
      validateExecutable: file => runtime.validateWorkbenchExecutable?.(file),
    });
  }
  listCli(refresh = false) { return this.cli.list(refresh); }
  resolveCli(node, binding) {
    const profile = binding.workbuddyCli;
    return this.cli.resolve(node.config.cli,binding.roots.project || binding.roots.runtime,binding.roots.output,{
      legacyPanelAuth: profile?.useLegacyPanelAuth === true,
      legacyTools: binding.roots.legacyTools,
      allowShell: Array.isArray(profile?.shellNodeIds) && profile.shellNodeIds.includes(node.id),
    });
  }
  async atomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { flag: "wx" }); await fs.rename(temp, file);
  }
  file(id) { this.projects.id(id); return path.join(this.root, "runs", `${id}.json`); }
  persist(run) {
    const previous=this.writes.get(run.id)||Promise.resolve();
    const operation=previous.then(async()=>{await this.atomic(this.file(run.id), run);
    await this.atomic(path.join(this.root,"history",`${run.id}.json`),{id:run.id,projectId:run.projectId,canvasId:run.canvasId,state:run.state,createdAt:run.createdAt,canvasRevision:run.canvasRevision});
    this.runtime.auditWorkbench?.("workbench_run_saved", run.id, "committed");
    const attemptStates = Object.fromEntries(Object.entries(run.attempts).map(([id, attempt]) => [id, attempt.state]));
    this.publish("workbench.changed", { runId: run.id, state: run.state, projectId: run.projectId, canvasId: run.canvasId, attemptStates });
    });this.writes.set(run.id,operation);return operation.finally(()=>{if(this.writes.get(run.id)===operation)this.writes.delete(run.id);});
  }
  async initialize() {
    if (!this.root) return;
    this.observeAgentEvents();
    const names = await fs.readdir(path.join(this.root, "locks")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const activeIds=new Set();
    for(const name of names.filter(name=>/^[a-f0-9]{64}$/.test(name))) {
      try{const owner=JSON.parse(await fs.readFile(path.join(this.root,"locks",name,"owner.json"),"utf8"));activeIds.add(this.projects.id(owner.runId));}
      catch{this.recordIssues.push({id:name,scope:"run-locks",code:"unreadable_record"});}
    }
    for (const id of activeIds) {
      try{
      await this.read(id);const run=this.runs.get(id);
      if(terminalRuns.has(run.state)){await this.release(run);continue;}
      if (!terminalRuns.has(run.state)) {
        // Absence from a new registry is not process-death evidence. Keep the durable resource lock.
        for (const attempt of Object.values(run.attempts)) if (["running", "cancelling"].includes(attempt.state)) {
          const node=run.snapshot.graph.nodes.find(node=>node.id===attempt.nodeId);
          attempt.state = node?.kind==="agent"&&attempt.dispatchStarted?"waiting_agent":"interrupted"; attempt.reason = "original_execution_liveness_unknown"; attempt.uncertain = true;
        }
        run.state = "interrupted"; run.reason = "original_owner_reconciliation_required"; await this.persist(run);
      }
      }catch{this.recordIssues.push({id,scope:"runs",code:"unreadable_record"});}
    }
    for(const run of this.runs.values())if(Object.values(run.attempts).some(attempt=>attempt.dispatchStarted&&!attempt.completionConfirmed))this.pump(run);
  }
  async read(id) {
    this.projects.id(id);let run=this.runs.get(id);
    if(!run){const raw=await fs.readFile(this.file(id),"utf8").catch(missing);if(!raw)throw new VideoError("运行记录不存在。",404);try{run=JSON.parse(raw);}catch{throw new VideoError("原运行记录损坏；已保留文件和执行锁，请恢复原证据。",409);}}
    if(!run || run.id!==id || !Array.isArray(run.snapshot?.graph?.nodes) || !run.binding?.roots || !run.attempts || typeof run.attempts!=="object")throw new VideoError("原运行记录损坏；已保留文件和执行锁，请恢复原证据。",409);
    this.runs.set(id,run);
    const completed=[...this.runs.values()].filter(row=>terminalRuns.has(row.state));
    for(const row of completed.slice(0,Math.max(0,completed.length-32)))if(row.id!==id)this.runs.delete(row.id);
    const view=structuredClone(run),titles=new Map(run.snapshot.graph.nodes.map(node=>[node.id,node.title||node.id]));
    for(const attempt of Object.values(view.attempts))attempt.title=titles.get(attempt.nodeId)||attempt.nodeId;
    return view;
  }
  async list(projectId,canvasId,query={}) {
    const limit=Number(query.limit||20);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new VideoError("历史分页数量无效。");
    const after=String(query.cursor||"");if(after)this.projects.id(after);
    const names=await fs.readdir(path.join(this.root,"history")).catch(error=>{if(error.code==="ENOENT")return[];throw error;});
    const rows=[];
    for(const name of names.sort().filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)&&name.slice(0,-5)>after)) {
      const row=JSON.parse(await fs.readFile(path.join(this.root,"history",name),"utf8"));
      if(row.projectId===projectId&&row.canvasId===canvasId)rows.push(row);if(rows.length>limit)break;
    }
    return{runs:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null,recordIssues:this.recordIssues};
  }
  async bindings(canvas) {
    const bindings = await this.runtime.workbenchBindings();
    const rawBinding = bindings.workspaces?.[canvas.workspaceBindingKey];
    const binding = rawBinding && resolveWorkbenchBinding(rawBinding,canvas.variables);
    if (!binding) throw new VideoError("执行电脑未配置此工作目录绑定。", 409);
    for (const key of ["runtime", "output", "materials"]) if (typeof binding.roots?.[key] !== "string" || !path.isAbsolute(binding.roots[key])) throw new VideoError(`缺少绝对路径绑定：${key}`, 409);
    const runtimePath = await fs.realpath(binding.roots.runtime);
    if (runtimePath.startsWith("\\\\")) throw new VideoError("执行目录必须位于本机磁盘。", 409);
    await this.runtime.validateWorkbenchRuntimeRoot?.(binding.roots.runtime);
    return structuredClone(binding);
  }
  async readTrigger(projectId,canvasId,id) {
    this.projects.id(projectId);this.projects.id(canvasId);this.projects.id(id);
    const record=JSON.parse(await fs.readFile(path.join(this.root,'triggers',id+'.json'),'utf8').catch(error=>{if(error.code==='ENOENT')throw new VideoError('触发记录不存在。',404);throw error;}));
    if(record.projectId!==projectId||record.templateId!==canvasId)throw new VideoError('触发记录不属于此模板。',404);
    return {trigger:record,...(record.runId?{run:await this.read(record.runId)}:{})};
  }
  trigger(projectId,canvasId,body,access) { return triggerWorkbench(this,projectId,canvasId,body,access); }
  async start(projectId, canvasId, body, access) {
    access?.beforeMutation();
    if (this.closing || this.runtime.readOnly || !this.root) throw new VideoError("运行拥有者不可用或只读。", 423);
    const operation = async () => {
      this.projects.id(body?.id);
      const intent = hash({ projectId, canvasId, ...body });
      const existing = await this.read(body.id).catch(error=>{if(error.status===404)return undefined;throw error;}); if (existing) { if (existing.intent !== intent) throw new VideoError("运行请求身份已用于不同参数。", 409); return existing; }
      const project = await this.projects.readProject(projectId, access), canvas = await this.projects.readCanvas(projectId, canvasId, access);
      if (body.revision !== canvas.revision) throw new VideoError("画布已更新，请重读后运行。", 409);
      const graph = validateCanvas(canvas, this.projects.definition), binding = await this.bindings(canvas);
      binding.roots={...binding.roots,canvas:this.projects.canvasDirectory(projectId,canvasId)};
      const resolved=resolveTemplates(canvas,this.projects.definition);
      const prompts = new Map();
      resolved.graph.nodes = resolved.graph.nodes.map(resolveNodeParameters).map(node => {
        const { textPreview, ...structure } = node;
        const { textPrompt, linkedMediaContext, ...config } = node.config;
        if (node.kind === "agent" && typeof textPrompt === "string") prompts.set(node.id, textPrompt);
        return { ...structure, config };
      });
      const snapshot = expandVariables(resolved, canvas.variables);
      for (const node of snapshot.graph.nodes) if (prompts.has(node.id)) node.config.textPrompt = prompts.get(node.id);
      const concurrency=body.concurrency??1;
      if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>16)throw new VideoError("并发数量须为 1–16。",400);
      const selected = new Set(snapshot.graph.nodes.filter(node => !node.config.legacyCardId).map(node => node.id));
      if (body.nodeId) {
        if (!selected.has(body.nodeId)) throw new VideoError("所选节点不存在。", 404);
        selected.clear(); selected.add(body.nodeId);
        if (body.mode === "from") for (const id of selected) for (const edge of graph.outgoing.get(id)) selected.add(edge.to);
        // Do not bypass dependencies outside the selected closure.
        for (const node of snapshot.graph.nodes.filter(node => selected.has(node.id))) if (graph.incoming.get(node.id).some(edge => !selected.has(edge.from)) || (node.inputs || []).some(input => input.producerNodeId && !selected.has(input.producerNodeId))) throw new VideoError("所选范围缺少前置完成证据，请先运行完整流程。", 409);
      }
      if(body.untilNodeId) {
        if(body.nodeId||!selected.has(body.untilNodeId))throw new VideoError('运行边界节点无效。',400);
        selected.clear();selected.add(body.untilNodeId);
        for(const id of selected){for(const edge of graph.incoming.get(id))selected.add(edge.from);for(const input of graph.nodes.get(id).inputs||[])if(input.producerNodeId)selected.add(input.producerNodeId);}
      }
      if (snapshot.graph.nodes.some(node => selected.has(node.id) && node.config.unresolved)) throw new VideoError("导入流程仍有未解析的命令、目标或检查项，请先补齐转换报告中的缺项。",409);
      const agents = snapshot.graph.nodes.filter(node => selected.has(node.id) && node.enabled !== false && node.kind === "agent");
      const contentLinks = canvas.mediaLinks ?? [];
      const receivesContent = new Set(contentLinks.map(link => link.to));
      if (agents.some(node => receivesContent.has(node.id))) {
        const { value } = await this.projects.readMediaEditor(projectId, canvasId, access, canvas.revision);
        const results = canvas.graph.nodes.filter(node => node.kind === "agent" && node.config.textOutput === true)
          .map(node => ({ id: node.id, kind: "text", text: node.textPreview?.text, generated: true }));
        const sources = [...(value?.items ?? []), ...results];
        for (const node of agents) {
          const context = resolveLinkedText(sources, contentLinks, node.id);
          if (context.length > 24000) throw new VideoError("连入的文本超过 24,000 字符，请缩短后运行。", 400);
          if (context) node.config.linkedMediaContext = context;
        }
      }
      for (const node of agents.filter(node => typeof node.config.textPrompt === "string")) {
        const target = agentTarget(node, binding), source = agentSource(node, binding);
        if (!node.config.cli && (!this.runtime.agentTasks || !target?.threadId || !target.agentAdapter || !source?.sourceThreadId || !source.sourceAgentType)) throw new VideoError("请先为此节点选择 CLI 或配置 Agent 会话。", 409);
        if (node.config.textPrompt.length > 10000) throw new VideoError("提示词最多 10,000 字符。", 400);
        if (!node.config.textPrompt.trim() && !node.config.linkedMediaContext) throw new VideoError("请输入提示词或连接有内容的文本。", 400);
      }
      for (const node of agents.filter(node => node.config.cli)) {
        try { await this.resolveCli(node,binding); }
        catch (error) { throw new VideoError(`${node.title || "Agent"}：${error.message}`, 409); }
      }
      const previous = body.resumeRunId ? await this.read(body.resumeRunId) : undefined;
      if (body.resumeRunId && (!previous || previous.projectId !== projectId || previous.canvasId !== canvasId || !terminalRuns.has(previous.state))) throw new VideoError("原运行仍未结束或不属于此画布。", 409);
      const run = { id: body.id, intent, projectId, canvasId, projectRevision: project.revision, canvasRevision: canvas.revision,
        generation: this.runtime.generation, machineId: this.runtime.machineId, createdAt: timestamp(), state: "running", snapshot,
        binding: structuredClone(binding), selected: [...selected], concurrency, attempts: {}, sequence: 0, ...(previous ? { resumedFromRunId: previous.id } : {}) };
      run.frozenInputs={};
      for(const node of snapshot.graph.nodes.filter(node=>selected.has(node.id))) {
        const refs=[...(node.inputs||[]).filter(input=>input.ref).map(input=>input.ref),...(node.kind==="agent"&&typeof node.config.textPrompt!=="string"&&node.config.briefRef?[node.config.briefRef]:[])];
        run.frozenInputs[node.id]=await Promise.all(refs.map(async ref=>({ref,...await fingerprint(binding.roots[ref.root],ref.path)})));
      }
      for (const id of graph.order.filter(id => selected.has(id))) run.attempts[id] = { id: randomUUID(), nodeId: id, state: "pending" };
      const resources = [...new Set([`canvas:${projectId}:${canvasId}`, ...(snapshot.graph.nodes.filter(node => selected.has(node.id)).map(node => node.resourceKey).filter(Boolean))])].sort();
      run.resources = resources;
      const acquired = [];
      try {
        for (const resource of resources) {
          const directory = path.join(this.root, "locks", hash(resource)); await fs.mkdir(path.dirname(directory), { recursive: true });
          try { await fs.mkdir(directory); } catch (error) { if (error.code === "EEXIST") throw new VideoError("画布或业务期次仍被原运行持有。", 409); throw error; }
          acquired.push(directory); await this.atomic(path.join(directory, "owner.json"), { runId: run.id, resource, machineId: run.machineId });
        }
        access?.beforeMutation();
        if (this.closing || this.runtime.readOnly || !this.root) throw new VideoError("运行拥有者不可用或只读。", 423);
        await this.persist(run); this.runs.set(run.id, run);
      } catch (error) { for (const directory of acquired) { await fs.unlink(path.join(directory, "owner.json")).catch(missing); await fs.rmdir(directory); } throw error; }
      this.pump(run, previous); return structuredClone(run);
    };
    const next = this.serial.then(operation); this.serial = next.catch(() => {}); return next;
  }
  pump(run, previous, retryPreparedAgent = false) {
    if (retryPreparedAgent) this.agentRetryRequests.add(run.id);
    if (this.flights.has(run.id)) {this.repump.add(run.id);return this.flights.get(run.id);}
    const retryAgent = this.agentRetryRequests.delete(run.id);
    const flight = this.advance(run, previous, retryAgent).catch(async error => { run.state = "interrupted"; run.reason = error.message; await this.persist(run); }).finally(() => {this.flights.delete(run.id);if(this.repump.delete(run.id)&&!terminalRuns.has(run.state)&&!run.cancelRequested&&!this.closing)this.pump(run);else this.agentRetryRequests.delete(run.id);});
    void flight.catch(error=>{run.state="interrupted";run.reason=error.message;try{this.runtime.auditWorkbench?.("workbench_run_persistence_failed",run.id,"failed");}catch{/* Original failure remains queryable in memory; retirement still joins the rejected flight. */}});
    this.flights.set(run.id, flight); return flight;
  }
  observeAgentEvents() {
    if(this.agentEventFlight||this.closing||!this.runtime.agentTasks?.events)return;
    const stream=this.runtime.agentTasks.events();if(!stream)return;
    this.agentEventStream=stream;
    this.agentEventFlight=(async()=>{for await(const frame of stream.frames){
      if(this.closing)break;
      if(frame.event!=='agent_requests_changed'&&frame.event!=='ready')continue;
      for(const run of this.runs.values())if(!run.cancelRequested&&!terminalRuns.has(run.state)&&Object.values(run.attempts).some(attempt=>attempt.dispatchStarted&&!attempt.completionConfirmed))this.pump(run);
    }})().catch(error=>{if(!this.closing)this.recordIssues.push({scope:'agent-events',code:'subscription_interrupted'});}).finally(()=>{this.agentEventStream=undefined;this.agentEventFlight=undefined;});
  }
  async advance(run, previous, retryPreparedAgent) {
    const { order, nodes, incoming } = validateCanvas(run.snapshot, this.projects.definition);
    const execute=async nodeId=>{for (const id of [nodeId]) {
      if (run.cancelRequested || this.closing) break;
      const node = nodes.get(id), attempt = run.attempts[id];
      if (this.projects.definition.nodeStates[attempt.state]?.terminal) continue;
      if(node.kind==="agent"&&attempt.dispatchStarted){await this.agent(run,node,attempt,retryPreparedAgent);await this.persist(run);continue;}
      if (Object.values(run.attempts).some(row => row.state === "failed" && nodes.get(row.nodeId).gate)) { attempt.state = "blocked"; attempt.reason = "gate_failed"; continue; }
      const edges = incoming.get(id), parents = edges.map(edge => run.attempts[edge.from]);
      if (parents.some(parent => !parent || !this.projects.definition.nodeStates[parent.state]?.terminal)) continue;
      if (edges.some(edge => {
        const parent = run.attempts[edge.from];
        if (parent.state === "skipped") return !(edge.condition === "completed" && edge.allowSkip);
        return edge.condition === "success" && parent.state !== "succeeded";
      })) { attempt.state = "blocked"; attempt.reason = "dependency_not_satisfied"; continue; }
      if (node.enabled === false) { attempt.state = "skipped"; continue; }
      const inputEvidence = [];
      try {
      for (const input of node.inputs || []) {
        if (input.producerNodeId) {
          const parent = run.attempts[input.producerNodeId], artifact = parent?.artifacts?.filter(row => row.key === input.artifactKey);
          if (parent?.state !== "succeeded" || !artifact?.length) throw new Error(`输入未就绪：${id}/${input.artifactKey}`);
          for (const row of artifact) {
            const current=await fingerprint(run.binding.roots[row.root],row.path);
            if(current.sha256!==row.sha256||current.bytes!==row.bytes)throw new Error("上游产物在完成后发生变化。");
            inputEvidence.push({...row,...current});
          }
        } else {
          if (!input.ref || !run.binding.roots[input.ref.root]) throw new Error("输入绑定未配置。");
          inputEvidence.push({ ref: input.ref, ...await fingerprint(run.binding.roots[input.ref.root], input.ref.path) });
        }
      }
      if(node.kind==="agent" && typeof node.config.textPrompt!=="string" && node.config.briefRef) {
        const ref=node.config.briefRef;
        inputEvidence.push({ref,...await fingerprint(run.binding.roots[ref.root],ref.path)});
      }
      for(const frozen of run.frozenInputs[id]||[]) {
        const current=inputEvidence.find(row=>row.ref?.root===frozen.ref.root&&row.ref?.path===frozen.ref.path);
        if(!current || current.sha256!==frozen.sha256 || current.bytes!==frozen.bytes)throw new Error("输入在运行受理后发生变化。");
      }
      }catch(error){attempt.state="blocked";attempt.reason=error.message;continue;}
      attempt.signature = hash({ node, variables: run.snapshot.variables, binding: run.binding, inputs: inputEvidence });
      const old = previous?.attempts[id];
      const parentsReused = [...edges.map(edge => edge.from), ...(node.inputs || []).map(input => input.producerNodeId).filter(Boolean)].every(parentId => run.attempts[parentId]?.reusedFromAttemptId);
      if (old?.state === "succeeded" && old.signature === attempt.signature && parentsReused) {
        const fingerprints = await Promise.all((old.artifacts || []).map(async row => ({ row, current: await fingerprint(run.binding.roots[row.root], row.path).catch(() => null) })));
        if (fingerprints.every(({ row, current }) => current?.sha256 === row.sha256 && current.bytes === row.bytes)) {
          attempt.state = "succeeded"; attempt.reusedFromAttemptId = old.id; attempt.artifacts = old.artifacts; attempt.validation = old.validation; await this.persist(run); continue;
        }
      }
      attempt.inputEvidence = inputEvidence;
      attempt.baseline ??= await inspectRequirements(node.requirements, run.binding.roots);
      if (run.cancelRequested || this.closing) { attempt.state = "cancelled"; continue; }
      if (node.kind === "human") { attempt.state = "waiting_human"; await this.persist(run); continue; }
      if (node.kind === "agent" && !node.config.cli) {
        await this.agent(run,node,attempt); await this.persist(run); continue;
      }
      attempt.state = "running"; attempt.startedAt = timestamp(); await this.persist(run);
      if (run.cancelRequested || this.closing) { attempt.state = "cancelled"; continue; }
      try {
        let receipt;
        if (node.kind === "asset") {
          const ref=node.config.ref;
          if(!ref?.root || !ref.path) throw new Error("资产节点缺少可核验的文件引用。");
          receipt={completed:true,asset:await fingerprint(run.binding.roots[ref.root],ref.path)};
        }
        else if (node.kind === "command") receipt = await this.command(run, node, attempt);
        else if (node.kind === "agent" && node.config.cli) receipt = await this.cliAgent(run, node, attempt);
        else if (node.kind === "generate") {
          if(!attempt.jobId) {
            attempt.jobId=node.config.jobId;
            if(!attempt.jobId&&node.config.command){
              attempt.mediaRequestStarted=true;await this.persist(run);
              if (run.cancelRequested || this.closing) {
                attempt.state = "cancelled"; delete attempt.mediaRequestStarted; delete attempt.uncertain; delete attempt.reason; continue;
              }
              try{const submitted=await this.media.submit(node.config.command,attempt.id,undefined,{deviceId:node.config.deviceId||""});attempt.jobId=submitted.id;}
              catch(error){
                const original=this.media.submissionReceipt?.(attempt.id);
                if(original)attempt.jobId=original.id;
                else {if(!error.status)error.uncertain=true;else delete attempt.uncertain;throw error;}
              }
            }
            if(!attempt.jobId)throw new Error("生成节点缺少生成参数或原媒体 jobId。");
            await this.persist(run);
          }
          if (run.cancelRequested || this.closing) { await this.cancelMedia(attempt); continue; }
          const job=await this.waitForMedia(attempt.jobId,attempt.id);
          if (run.cancelRequested || this.closing) continue;
          if (job.status !== "succeeded") throw new Error("原媒体任务未成功。");
          receipt = { jobId: job.id, completed: true };
        } else throw new Error("节点能力不可执行。");
        if (run.cancelRequested || this.closing) { attempt.state = "cancelled"; delete attempt.uncertain; continue; }
        if (!receipt.completed) throw new Error("执行未取得完成证据。");
        Object.assign(attempt, await validateArtifacts(node, run.binding.roots, attempt.baseline, receipt, attempt.id, run.machineId));
        if (receipt.outputText !== undefined) attempt.outputText = receipt.outputText;
        if(node.kind==="asset")attempt.artifacts.push({artifactId:randomUUID(),attemptId:attempt.id,machineId:run.machineId,key:node.config.artifactKey||"asset",root:node.config.ref.root,path:node.config.ref.path,...receipt.asset});
        attempt.receipt = receipt; attempt.state = "succeeded";
      } catch (error) { attempt.state = error.uncertain?"interrupted":run.cancelRequested ? "cancelled" : "failed";if(error.uncertain)attempt.uncertain=true;attempt.reason = error.message; }
      attempt.finishedAt = timestamp(); await this.persist(run);
    }};
    const remaining=new Set(order.filter(id=>run.selected.includes(id)));
    while(remaining.size&&!run.cancelRequested&&!this.closing) {
      const eligible=order.filter(id=>remaining.has(id)&&[...incoming.get(id).map(edge=>edge.from),...(nodes.get(id).inputs||[]).map(input=>input.producerNodeId).filter(Boolean)].every(parent=>!remaining.has(parent)));
      const batch=[],keys=new Set();
      for(const id of eligible){const key=nodes.get(id).resourceKey;if(key&&keys.has(key))continue;batch.push(id);if(key)keys.add(key);if(batch.length>=run.concurrency)break;}
      if(!batch.length)throw new Error("调度依赖无法满足。");
      await Promise.all(batch.map(execute));for(const id of batch)remaining.delete(id);
    }
    this.summarize(run); await this.persist(run);
    if (terminalRuns.has(run.state)) await this.release(run);
  }
  summarize(run) {
    const attempts = Object.values(run.attempts), nodes = new Map(run.snapshot.graph.nodes.map(node => [node.id, node]));
    run.failures = attempts.filter(row => ["failed", "blocked", "interrupted"].includes(row.state)).map(row => row.nodeId);
    run.waiting = attempts.filter(row => ["waiting_human", "waiting_agent"].includes(row.state)).map(row => ({ nodeId: row.nodeId, state: row.state }));
    const active = attempts.some(row => ["running", "cancelling"].includes(row.state)||row.state==="waiting_agent"&&row.dispatchStarted&&!row.completionConfirmed&&!preparedAgentCanRetry(row, row.originalReceipt));
    run.state = run.cancelRequested ? active || attempts.some(row => row.uncertain) ? "cancelling" : "cancelled"
      : active ? "running" : attempts.some(row => row.state === "failed" && nodes.get(row.nodeId).gate) ? "failed"
      : attempts.some(row => row.state === "interrupted") ? "interrupted"
      : run.waiting.some(row => row.state === "waiting_human") ? "waiting_human"
      : run.waiting.length ? "waiting_agent"
      : run.failures.length ? "completed_with_errors"
      : attempts.every(row => this.projects.definition.nodeStates[row.state]?.terminal) ? "succeeded" : "interrupted";
  }
  async applyCheckParameters(run,node,attempt) {
    const changes=node.config.checkOverrides;if(!changes||!Object.keys(changes).length)return;
    const sink=run.binding.parameterDocuments?.[node.config.checkParameterSink];
    if(!sink||!sink.group||!sink.ref)throw new Error('阈值配置未在执行电脑绑定。');
    const file=await ownedFile(run.binding.roots[sink.ref.root],sink.ref.path),before=await fingerprint(run.binding.roots[sink.ref.root],sink.ref.path);
    const data=JSON.parse(await fs.readFile(file,'utf8')),group=data[sink.group];
    if(!Array.isArray(group?.items))throw new Error('阈值配置分组不存在。');
    for(const [key,value] of Object.entries(changes)){const row=group.items.find(row=>row.key===key);if(!row)throw new Error('阈值配置没有此字段：'+key);row.limit=value;}
    const current=await fingerprint(run.binding.roots[sink.ref.root],sink.ref.path);if(current.sha256!==before.sha256)throw new Error('阈值配置已被其它执行者修改。');
    await this.atomic(file,data);attempt.parameterDocument={ref:sink.ref,...await fingerprint(run.binding.roots[sink.ref.root],sink.ref.path)};
    this.runtime.auditWorkbench?.('workbench_parameters_saved',attempt.id,'committed');
  }
  async prepareCommandEvidence(run, nodeId) {
    const earlierRuns = [];
    const visited = new Set([run.id]);
    let current = run;
    while (current.resumedFromRunId && !visited.has(current.resumedFromRunId) &&
        Object.values(current.attempts).some(attempt => attempt.reusedFromAttemptId)) {
      const previous = await this.read(current.resumedFromRunId).catch(error => {
        if (error.status === 404) return;
        throw error;
      });
      if (!previous || previous.projectId !== run.projectId || previous.canvasId !== run.canvasId) break;
      visited.add(previous.id);
      earlierRuns.push(previous);
      current = previous;
    }
    return prepareLinearRunEvidence(run, path.join(this.root, "runs", run.id + ".jsonl"), nodeId, run.binding.roots.runtime, earlierRuns);
  }
  async command(run, node, attempt, cli) {
    if (!cli) await this.applyCheckParameters(run,node,attempt);
    const tool = cli ?? run.binding.tools?.[node.config.toolKey];
    if (!tool || typeof tool.executable !== "string" || !path.isAbsolute(tool.executable)) throw new Error("命令工具未在执行电脑绑定。");
    await this.runtime.validateWorkbenchExecutable?.(tool.executable);
    const args = cli?.argv ?? node.config.argv;
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("命令参数必须为字符串数组。");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, val]) => val && ["path", "systemroot", "windir", "temp", "tmp", "pathext"].includes(key.toLowerCase())));
    for(const [key,value] of Object.entries(tool.env||{})){if(typeof value!=="string"||value.includes("\0"))throw new Error("工具环境配置无效。");env[key]=cli ? value : expandRootReferences(expandVariables(value,run.snapshot.variables),run.binding.roots);}
    const secrets = cli ? Object.entries(cli.env).filter(([key])=>/(_KEY|_PROXY)$/i.test(key)).map(([,value])=>value) : [];
    for (const [key, reference] of Object.entries(tool.envRefs || {})) { if (!process.env[reference]) throw new Error("命令环境变量引用不可用。"); env[key] = process.env[reference]; secrets.push(env[key]); }
    const redactions = [...new Set(secrets.flatMap(secret => [secret, ...secret.split(/[\r\n]+/) ]).filter(Boolean))].sort((a, b) => b.length - a.length);
    const redact = text => redactions.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
    const buffers = new Map(),withheld=new Set(); let logQueue = Promise.resolve();
    const output = (stream, text) => {
      if(withheld.has(stream)){const end=text.indexOf("\n");if(end<0)return;withheld.delete(stream);text=text.slice(end+1);}
      let pending = (buffers.get(stream) || "") + text;
      if (pending.length > 65536) { buffers.set(stream, "");if(!pending.endsWith("\n"))withheld.add(stream); pending = "[oversized output line withheld]\n"; }
      const lines = pending.split(/\r?\n/); buffers.set(stream, lines.pop());
      for (const line of lines) {
        if (cli && stream === "stdout") { cli.onLine(line); continue; }
        logQueue = logQueue.then(() => this.log(run, { attemptId: attempt.id, stream, text: redact(line) }));
      }
      return logQueue;
    };
    const timeoutMs = node.config.timeoutMs ?? 600000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error("命令超时参数无效。");
    const evidenceMode = node.config.runEvidence;
    if (evidenceMode !== undefined && evidenceMode !== "linear") throw new Error("命令运行证据格式无效。");
    const evidence = evidenceMode === "linear"
      ? await this.prepareCommandEvidence(run, node.id)
      : undefined;
    try {
      if (run.cancelRequested || this.closing) return;
      if (evidence) {
        env.RABI_WORKBENCH_RUN_EVIDENCE = evidence.file;
        this.runtime.auditWorkbench?.("workbench_run_evidence_prepared", attempt.id, "committed");
      }
      const argv = cli ? args : [...(tool.argvPrefix || []), ...args].map(arg=>expandRootReferences(arg,run.binding.roots));
      const handle = this.runtime.launchWorkbenchProcess({ attemptId: attempt.id, executable: tool.executable, argv, cwd: cli?.cwd ?? run.binding.roots.runtime, env, timeoutMs, ...(cli && { stdin: cli.prompt }) }, output);
      this.processes.set(attempt.id, handle); attempt.leaseId = handle.id; await this.persist(run);
      const receipt = await handle.settled;delete attempt.uncertain;for (const [stream, text] of buffers) if (text) output(stream, "\n"); await logQueue;
      if(receipt.outputError)throw new Error("命令输出未能持久化。");
      if(receipt.inputError)throw new Error("CLI 任务书未完整送入进程。");
      if (receipt.exitCode !== 0 || receipt.timedOut) throw new Error(receipt.timedOut ? "命令超时。" : `命令退出码：${receipt.exitCode}`);
      return { ...receipt, completed: true, ...(node.config.validationOnly ? { validated: attempt.inputEvidence.filter(row => row.ref).map(row => ({ path: row.ref.path, sha256: row.sha256 })) } : {}) };
    } finally {
      this.processes.delete(attempt.id);
      if (evidence) await evidence.dispose().catch(() => this.runtime.auditWorkbench?.("workbench_run_evidence_cleanup_failed", attempt.id, "failed"));
    }
  }
  async agentBrief(run,node,attempt) {
    let brief = node.config.textPrompt;
    if (typeof brief !== "string") {
      const ref = node.config.briefRef;
      if (!ref) throw new Error("Agent 节点缺少任务书。");
      const file = await ownedFile(run.binding.roots[ref.root],ref.path);
      brief = expandRootReferences(expandVariables(await fs.readFile(file,"utf8"),run.snapshot.variables),run.binding.roots);
    }
    if (node.config.linkedMediaContext) brief += "\n\n引用的画布文本：\n" + node.config.linkedMediaContext;
    const projection = node.config.contextProjection;
    if (projection) {
      const root = run.binding.roots[projection.ref?.root];
      if (!root) throw new Error("结构化上下文缺少绑定根。");
      const file = await ownedFile(root,projection.ref.path);
      if ((await fs.stat(file)).size > 2*1024*1024) throw new Error("结构化上下文超过大小上限。");
      let rows = JSON.parse(await fs.readFile(file,"utf8"));
      for (const key of String(projection.list || "").split(".").filter(Boolean)) rows = rows?.[key];
      if (!Array.isArray(rows)) throw new Error("结构化上下文列表不存在。");
      if (!Array.isArray(projection.fields) || projection.fields.some(key=>typeof key!=="string")) throw new Error("结构化上下文字段无效。");
      brief += "\n本期结构化输入（沿用上游结果）：\n" + JSON.stringify(rows.map(row=>Object.fromEntries(projection.fields.map(key=>[key,row?.[key]??null]))));
    }
    return brief + "\n\n" + JSON.stringify({attemptId:attempt.id,variables:run.snapshot.variables,context:node.config.context||{},parameters:node.config.parameterValues||{},requirements:node.requirements||[],roots:run.binding.roots});
  }
  async cliAgent(run,node,attempt) {
    await this.applyCheckParameters(run,node,attempt);
    const { roots } = run.binding, selection = node.config.cli;
    const cwd = roots.project || roots.runtime;
    await this.runtime.validateWorkbenchRuntimeRoot?.(cwd);
    const execution = await this.resolveCli(node,run.binding);
    const brief = await this.agentBrief(run,node,attempt);
    if (run.cancelRequested || this.closing) return;
    await fs.mkdir(roots.output,{recursive:true});
    let completed = false, response, authenticationRequired = false;
    const receipt = await this.command(run,node,attempt,{
      ...execution,
      prompt: brief + '\n\n只执行本节点，在声明的目录保存产物。最终回答只返回 JSON 对象，含 status（succeeded 或 failed）、reason。把实际检查过的核验产物相对路径放入 reviewedPaths 数组，文件摘要由工作台读取。只有这次确实写出的同内容文件才能回报 writes:[{root,path,sha256,attemptId}]。' + (node.config.textOutput === true ? ' 将生成的文字放在 text 字段，最多 24,000 字符。' : ''),
      onLine(line) {
        const event = readCliEvent(selection.provider,line);
        if (typeof event?.text === "string") response = event.text;
        if (event?.completed !== undefined) completed = event.completed;
        if (event?.authenticationRequired) authenticationRequired = true;
      },
    });
    if (run.cancelRequested || this.closing) return;
    if (authenticationRequired) throw new Error("WorkBuddy CLI 需要登录或补齐当前工作区的授权。");
    if (!completed || !response) throw new Error("CLI 没有返回完成回执。");
    const json = response.trim().replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i,"$1");
    let result;
    try { result = JSON.parse(json); } catch { throw new Error("CLI 没有返回结构化任务结果。"); }
    const redact = value => Object.entries(execution.env).filter(([key,value])=>value && /(_KEY|_PROXY)$/i.test(key)).reduce((text,[,secret])=>text.split(secret).join("[redacted]"),value);
    if (result?.status !== "succeeded") throw new Error(redact(String(result?.reason || "CLI 任务失败。")).slice(0,500));
    const outputText = node.config.textOutput === true ? result.text : undefined;
    if (node.config.textOutput === true && (typeof outputText !== "string" || !outputText.trim() || outputText.length > 24000)) throw new Error("CLI 没有返回有效的生成文本。");
    const reviewed = new Set(Array.isArray(result.reviewedPaths) ? result.reviewedPaths : []);
    const files = await inspectRequirements(node.requirements?.filter(row=>row.freshness === "validated"), roots);
    const validated = files.filter(file=>reviewed.has(file.path)).map(({path,sha256})=>({path,sha256}));
    const evidence = value => Array.isArray(value) ? value.filter(row=>typeof row?.root === "string" && typeof row.path === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && typeof row.attemptId === "string")
      .map(({root,path,sha256,attemptId})=>({root,path,sha256,attemptId})) : [];
    return { ...receipt, provider: selection.provider, ...(outputText !== undefined && {outputText:redact(outputText)}),
      validated, writes:evidence(result.writes), reused:evidence(result.reused) };
  }
  async agent(run,node,attempt,retryPreparedAgent = false) {
    attempt.state="waiting_agent";
    const target = agentTarget(node, run.binding);
    const source = agentSource(node, run.binding);
    if(!this.runtime.agentTasks || !target?.threadId || !target.agentAdapter || !source?.sourceThreadId || !source?.sourceAgentType) {attempt.reason="exact_agent_target_and_source_required";return;}
    if(node.config.independentFromNodeId) {
      const authorNode=run.snapshot.graph.nodes.find(row=>row.id===node.config.independentFromNodeId);
      const author=agentTarget(authorNode,run.binding);
      if(!author || author.threadId===target.threadId && author.agentAdapter===target.agentAdapter) {attempt.state="failed";attempt.reason="independent_reviewer_required";return;}
    }
    let original = attempt.dispatchStarted ? await this.runtime.agentTasks.inspect(attempt.id, target.threadId, target.agentAdapter) : undefined;
    const retryPrepared = retryPreparedAgent && preparedAgentCanRetry(attempt, original);
    if(!attempt.dispatchStarted || retryPrepared) {
      if (!retryPrepared) await this.applyCheckParameters(run,node,attempt);
      if (typeof node.config.textPrompt !== "string" && !node.config.briefRef) { attempt.reason="agent_brief_reference_required"; return; }
      const brief = await this.agentBrief(run,node,attempt);
      if (run.cancelRequested || this.closing) { attempt.state = "cancelled"; return; }
      const briefHash = hash(brief);
      if (retryPrepared && attempt.briefHash !== briefHash) {
        attempt.originalReceipt = original;
        attempt.reason = "原任务书内容已变化，无法用原投递编号恢复。";
        return;
      }
      attempt.briefHash=briefHash;attempt.dispatchStarted=true;
      delete attempt.acceptance;
      await this.persist(run);
      if (run.cancelRequested || this.closing) {
        attempt.state = "cancelled"; delete attempt.dispatchStarted; delete attempt.uncertain; delete attempt.reason; return;
      }
      try {
        const {threadId,agentAdapter,instanceBinding,agentTargetId,cwd}=target,{sourceThreadId,sourceAgentType,messageSource}=source;
        attempt.acceptance=await this.runtime.agentTasks.send({threadId,agentAdapter,instanceBinding,agentTargetId,cwd,sourceThreadId,sourceAgentType,messageSource,action:"send",createIfMissing:false,deliveryId:attempt.id,responsePolicy:"required",
          model:node.config.parameterValues?.model || node.config.parameterSchema?.find(row=>row.name==="model")?.default,
          responseInstruction:'Use the original Agent reply contract to submit the result field for this request. A chat message does not complete the workflow node. Set result to a plain JSON string with status succeeded|failed and reason. For validated requirements include validated:[{path,sha256}]; for unchanged produced files provide writes:[{root,path,sha256,attemptId}] only when this attempt actually wrote them. All required artifacts are independently checked.'+(node.config.textOutput === true ? ' Include the generated answer in a string field named "text" (up to 24,000 characters).' : ""),prompt:brief});
      } catch {attempt.reason="delivery_outcome_unknown_query_original_request";}
      original = await this.runtime.agentTasks.inspect(attempt.id,target.threadId,target.agentAdapter);
    }
    attempt.originalReceipt=original;
    if(original?.request?.status!=="responded") {
      attempt.reason = preparedAgentCanRetry(attempt, original)
        ? "Agent 任务尚未送达。连接恢复后，核对可继续原投递。"
        : "original_agent_completion_pending";
      if(original?.request?.status==="awaiting_response")attempt.state="running";
      return;
    }
    attempt.completionConfirmed=true;delete attempt.uncertain;
    const responder=original.request.response?.by;
    if(responder?.threadId!==target.threadId || responder.agentAdapter && responder.agentAdapter!==target.agentAdapter) {attempt.state="failed";attempt.reason="completion_target_mismatch";return;}
    let completion;
    try { completion = JSON.parse(original.request.response.result); }
    catch { /* The confirmed reply is immutable. Report an invalid result as a failure below. */ }
    if (completion?.status === "failed") { attempt.state = "failed"; attempt.reason = String(completion.reason || "Agent 执行失败。"); return; }
    if (completion?.status !== "succeeded") { attempt.state = "failed"; attempt.reason = "structured_completion_receipt_required"; return; }
    try {
      if (node.config.textOutput === true && (typeof completion.text !== "string" || !completion.text.trim() || completion.text.length > 24000)) throw new Error("Agent 没有返回有效的生成文本。");
      Object.assign(attempt,await validateArtifacts(node,run.binding.roots,attempt.baseline,completion,attempt.id,run.machineId));
      if (node.config.textOutput === true) attempt.outputText = completion.text;
      delete attempt.reason;
      attempt.state="succeeded";attempt.receipt={requestId:original.request.id,deliveryId:original.deliveryId,response:original.request.response};
    }
    catch(error){attempt.state="failed";attempt.reason=error.message;}
  }
  async reconcileCancelledAgent(run, node, attempt) {
    const tasks = this.runtime.agentTasks;
    const target = agentTarget(node, run.binding);
    const original = await tasks?.inspect(attempt.id, target?.threadId, target?.agentAdapter);
    if (original?.request?.status === "responded") return true;
    if (!tasks?.freezeUnsent || !provenUnsentAgentReceipt(attempt, original,
      original?.state === "frozen" ? "frozen" : "prepared")) return false;
    const source = agentSource(node, run.binding);
    if (!source?.sourceThreadId || !target?.threadId || !target.agentAdapter) return false;
    const binding = {
      callerDeliveryId: attempt.id,
      deliveryId: original.deliveryId,
      requestId: original.request.id,
      sourceThreadId: source.sourceThreadId,
      targetThreadId: target.threadId,
      targetProvider: target.agentAdapter,
    };
    const receipt = await tasks.freezeUnsent(binding);
    if (receipt?.callerDeliveryId !== binding.callerDeliveryId || receipt.deliveryId !== binding.deliveryId
      || receipt.requestId !== binding.requestId || !Number.isFinite(Date.parse(receipt.frozenAt))) return false;
    attempt.cancellationEvidence = { kind: "original_agent_delivery_frozen", ...receipt };
    return true;
  }

  async refresh(id,access) {
    this.observeAgentEvents();
    access?.beforeMutation();await this.read(id);const run=this.runs.get(id);
    if(run.cancelRequested) {
      for(const attempt of Object.values(run.attempts).filter(attempt=>attempt.uncertain)) {
        const node=run.snapshot.graph.nodes.find(node=>node.id===attempt.nodeId);
        const exited=node.kind==="agent"&&!node.config.cli? await this.reconcileCancelledAgent(run,node,attempt)
          :node.kind==="generate"? this.media.catalog?.states[this.media.jobs.get(attempt.jobId)?.status]?.terminal
          :this.runtime.queryWorkbenchProcess?.(attempt.id)?.state==="exited";
        if(exited){attempt.state="cancelled";delete attempt.uncertain;}
      }
      this.summarize(run);await this.persist(run);if(run.state==="cancelled")await this.release(run);
    }
    if(!run.cancelRequested && Object.values(run.attempts).some(attempt=>attempt.state==="waiting_agent"||attempt.state==="running"&&attempt.dispatchStarted))this.pump(run, undefined, true);
    return this.read(id);
  }
  log(run, entry) {
    const previous=this.logWrites.get(run.id)||Promise.resolve();
    const next=previous.then(async()=>{const row={sequence:++run.sequence,at:timestamp(),...entry};await fs.appendFile(path.join(this.root,"runs",`${run.id}.jsonl`),JSON.stringify(row)+"\n");});
    this.logWrites.set(run.id,next);return next.finally(()=>{if(this.logWrites.get(run.id)===next)this.logWrites.delete(run.id);});
  }
  onMediaChanged(jobId) {
    const job=this.media.jobs.get(jobId);if(!job||!this.media.catalog?.states[job.status]?.terminal)return;
    for(const resolve of this.mediaWaiters.get(jobId)?.values()||[])resolve(job);this.mediaWaiters.delete(jobId);
  }
  waitForMedia(jobId,attemptId) {
    const job=this.media.jobs.get(jobId);if(!job)return Promise.reject(new Error("原媒体任务不存在。"));
    if(this.media.catalog?.states[job.status]?.terminal || job.status==="succeeded")return Promise.resolve(job);
    return new Promise(resolve=>{const listeners=this.mediaWaiters.get(jobId)||new Map();listeners.set(attemptId,resolve);this.mediaWaiters.set(jobId,listeners);this.onMediaChanged(jobId);});
  }
  async cancelMedia(attempt) {
    attempt.state = "cancelling"; attempt.uncertain = true;
    try {
      const job = this.media.jobs.get(attempt.jobId);
      if (!this.media.catalog?.states[job?.status]?.terminal) await this.media.cancel(attempt.jobId);
    } catch { attempt.reason = "original_media_job_still_running"; }
    const job = this.media.jobs.get(attempt.jobId);
    if (this.media.catalog?.states[job?.status]?.terminal) {
      attempt.state = "cancelled"; delete attempt.uncertain; delete attempt.reason;
    }
    // The original media owner keeps running jobs. Retirement joins only this run's cancellation handling.
    this.onMediaChanged(attempt.jobId);
    const listeners = this.mediaWaiters.get(attempt.jobId);
    listeners?.get(attempt.id)?.(job); listeners?.delete(attempt.id);
    if (listeners?.size === 0) this.mediaWaiters.delete(attempt.jobId);
  }
  async logs(id, after = 0, limit = 100) {
    await this.read(id); if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new VideoError("日志游标无效。");
    const rows = [], file = path.join(this.root, "runs", `${id}.jsonl`);
    if (!await fs.stat(file).catch(missing)) return { entries: [], nextCursor: after };
    const stream = createReadStream(file), reader = createInterface({ input: stream, crlfDelay: Infinity });
    try { for await (const line of reader) { const row = JSON.parse(line); if (row.sequence > after) rows.push(row); if (rows.length >= limit) break; } }
    finally { reader.close(); stream.destroy(); }
    return { entries: rows, nextCursor: rows.at(-1)?.sequence ?? after };
  }
  async artifactContent(id,artifactId,request,access,signal) {
    access?.assert();this.projects.id(artifactId);const run=await this.read(id);
    const artifact=Object.values(run.attempts).flatMap(attempt=>attempt.artifacts||[]).find(row=>row.artifactId===artifactId);
    if(!artifact)throw new VideoError("产物不属于此运行。",404);
    const root=run.binding.roots[artifact.root],file=await ownedFile(root,artifact.path),current=await fingerprint(root,artifact.path);
    if(current.sha256!==artifact.sha256||current.bytes!==artifact.bytes)throw new VideoError("产物已变化，请核对原验证记录。",409);
    const extension=path.extname(artifact.path).toLowerCase(),mime={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".mp4":"video/mp4",".wav":"audio/wav",".mp3":"audio/mpeg",".txt":"text/plain; charset=utf-8",".json":"text/plain; charset=utf-8",".md":"text/plain; charset=utf-8"}[extension]||"application/octet-stream";
    access?.assert();return openMedia(request,file,mime,path.basename(artifact.path),access,{signal});
  }
  async completeHuman(id, body, access) {
    access?.beforeMutation(); const run = this.runs.get(this.projects.id(id)), attempt = run?.attempts[body?.nodeId];
    if (!attempt || run.cancelRequested || attempt.state !== "waiting_human" || attempt.id !== body.attemptId || typeof body.identity !== "string" || !body.identity.trim() || !body.evidence) throw new VideoError("人工提交需要原 attempt、身份与证据。", 409);
    const node = run.snapshot.graph.nodes.find(node => node.id === body.nodeId);
    Object.assign(attempt, await validateArtifacts(node, run.binding.roots, attempt.baseline, body.evidence, attempt.id, run.machineId));
    attempt.state = "succeeded"; attempt.receipt = { identity: body.identity, evidence: body.evidence }; await this.persist(run); this.pump(run); return this.read(id);
  }
  async cancel(id, access) {
    access?.beforeMutation();await this.read(id);const run = this.runs.get(id);
    if (terminalRuns.has(run.state)) return this.read(id);
    run.cancelRequested = true; run.state = "cancelling";
    for (const attempt of Object.values(run.attempts)) {
      const process = this.processes.get(attempt.id);
      if (process) {
        attempt.state = "cancelling";let timer;
        try {await Promise.race([process.cancel(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("termination_unconfirmed")),3000);})]);attempt.state="cancelled";}
        catch {attempt.uncertain=true;}finally{clearTimeout(timer);}
      }
      else if (["pending", "ready", "waiting_human"].includes(attempt.state)) attempt.state = "cancelled";
      else if(attempt.state==="running"&&attempt.dispatchStarted){attempt.state="cancelling";attempt.uncertain=true;attempt.reason="original_agent_claim_release_required";}
      else if (["running", "cancelling"].includes(attempt.state) && attempt.jobId) await this.cancelMedia(attempt);
      else if (["running", "cancelling"].includes(attempt.state) && attempt.mediaRequestStarted) {attempt.state="cancelling";attempt.uncertain=true;attempt.reason="original_media_submission_outcome_unknown";}
      else if (attempt.state === "waiting_agent") {if(!attempt.dispatchStarted)attempt.state="cancelled";else{attempt.uncertain = true; attempt.reason = "original_agent_claim_release_required";}}
    }
    this.summarize(run); await this.persist(run); if (run.state === "cancelled") await this.release(run); return this.read(id);
  }
  release(run) {
    if(this.releases.has(run.id)) return this.releases.get(run.id);
    const flight=(async()=>{for (const resource of run.resources) {
      const directory = path.join(this.root, "locks", hash(resource)), text=await fs.readFile(path.join(directory,"owner.json"),"utf8").catch(missing);
      if(!text)continue;const owner=JSON.parse(text);
      if (owner.runId !== run.id) throw new Error("运行资源锁归属变化。");
      await fs.unlink(path.join(directory, "owner.json")); await fs.rmdir(directory);
    }})();this.releases.set(run.id,flight);return flight;
  }
  async close() { this.closing = true; const cancellations=Promise.all([...this.runs.values()].filter(run => !terminalRuns.has(run.state)).map(run => this.cancel(run.id))); await Promise.all([cancellations,Promise.resolve(this.agentEventStream?.cancel()).then(()=>this.agentEventFlight)]); await Promise.all([...this.flights.values()]); }
}
