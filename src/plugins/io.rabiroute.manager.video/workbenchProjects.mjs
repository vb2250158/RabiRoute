import path from "node:path";
import rawFs from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { checkedFs } from "./requestAccess.mjs";
import { VideoError } from "./service.mjs";
import { validateCanvas, cloneGraph, relativeMaterialPath,externalDependencies } from "./workbenchGraph.mjs";
import { importWorkbench,exportLinear } from "./workbenchImport.mjs";
import {projectRules} from "./contracts.mjs";

const uuid = /^[a-f0-9-]{36}$/;
const digest = value => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const absent = error => { if (error.code === "ENOENT") return undefined; throw error; };
const pools = new Map();
function pool(root) { if (!pools.has(root)) pools.set(root, { queues: new Map(), indexes: new Map() }); return pools.get(root); }

/** v1 and v2 share this owner, authority checks and publication primitives. */
export class WorkbenchProjects {
  constructor(runtime, definition) {
    this.runtime = runtime; this.definition = definition; this.legacyRoot=path.join(runtime.stateRoot,"projects");this.root = runtime.workbenchProjectsRoot || this.legacyRoot;
    this.pool = pool(this.root);
    this.canonicalRoots=new Map();
  }
  id(id) { if (typeof id !== "string" || !uuid.test(id)) throw new VideoError("项目或画布不存在。", 404); return id; }
  projectDirectory(id) { return path.join(this.root, this.id(id)); }
  canvasDirectory(projectId, canvasId) { return path.join(this.projectDirectory(projectId), "canvases", this.id(canvasId)); }
  within(root,file){const relative=path.relative(root,file);return relative===""||relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);}
  async canonical(root,access){if(!this.canonicalRoots.has(root))this.canonicalRoots.set(root,await checkedFs(access).realpath(root));return this.canonicalRoots.get(root);}
  async json(file, access) {
    const fs=checkedFs(access),stat=await fs.lstat(file);if(stat.isSymbolicLink())throw new VideoError("记录不能通过链接读取。",403);
    const real=await fs.realpath(file);let owned=false;
    for(const root of new Set([this.root,this.legacyRoot])){const canonical=await this.canonical(root,access).catch(absent);if(canonical&&this.within(canonical,real)){owned=true;break;}}
    if(!owned)throw new VideoError("记录路径越出存储根。",403);
    return JSON.parse(await fs.readFile(real, "utf8"));
  }
  async safeParent(file,access){
    const fs=checkedFs(access),root=[...new Set([this.root,this.legacyRoot])].sort((a,b)=>b.length-a.length).find(root=>this.within(root,file));
    if(!root)throw new VideoError("写入路径越出存储根。",403);
    await fs.mkdir(root,{recursive:true});const canonical=await this.canonical(root,access);
    let ancestor=path.dirname(file);while(!await fs.lstat(ancestor).catch(absent)){const parent=path.dirname(ancestor);if(parent===ancestor)throw new VideoError("存储根不可用。",409);ancestor=parent;}
    if(!this.within(canonical,await fs.realpath(ancestor)))throw new VideoError("写入目录通过链接越出存储根。",403);
  }
  async atomic(file, value, access) {
    const fs = checkedFs(access), temporary = `${file}.${randomUUID()}.tmp`;
    await this.safeParent(file,access);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx" });
    await fs.rename(temporary, file);
  }
  async locked(key, access, operation) {
    access?.assert();
    if (this.runtime.readOnly) throw new VideoError("当前服务只读，无法保存项目。", 423);
    const previous = this.pool.queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      const fs = checkedFs(access), lock = path.join(this.root, ".locks", digest(key));
      await this.safeParent(lock,access);
      await fs.mkdir(path.dirname(lock), { recursive: true });
      try { await fs.mkdir(lock); }
      catch (error) { if (error.code === "EEXIST") throw new VideoError("此记录正由另一存储拥有者修改；请稍后重读。未确认退出的锁不会自动移除。", 409); throw error; }
      try { access?.assert(); return await operation(); }
      finally { await rawFs.rmdir(lock); }
    });
    this.pool.queues.set(key, result);
    try { return await result; } finally { if (this.pool.queues.get(key) === result) this.pool.queues.delete(key); }
  }
  async modern(id, access) { return this.json(path.join(this.projectDirectory(id), "project.json"), access).catch(absent); }
  async readProject(id, access, allowPrepared=false) {
    const record = await this.modern(id, access);
    if (!record) throw new VideoError("项目尚未迁移，请从旧媒体页面显式迁移。", 409);
    if (record.version !== 2 || record.id !== id || !Number.isSafeInteger(record.revision) || record.revision<0 || typeof record.title!=="string" || typeof record.updatedAt!=="string" || !uuid.test(record.defaultCanvasId)) throw new VideoError("项目元数据损坏。", 409);
    if(!allowPrepared&&record.migration?.phase==="prepared")throw new VideoError("原迁移尚未提交，请从项目列表恢复迁移。",409);
    return record;
  }
  async readCanvas(projectId, canvasId, access) {
    await this.readProject(projectId, access);
    const record = await this.json(path.join(this.canvasDirectory(projectId, canvasId), "canvas.json"), access).catch(absent);
    if (!record) throw new VideoError("画布不存在，请返回画布列表。", 404);
    if (record.id !== canvasId || !Number.isSafeInteger(record.revision)) throw new VideoError("画布记录损坏。", 409);
    try { validateCanvas(record, this.definition); } catch (error) { throw new VideoError(error.message, 409); }
    return {...record,externalDependencies:externalDependencies(record)};
  }
  summary(record) { return { id: record.id, name: record.name, revision: record.revision, updatedAt: record.updatedAt, nodeCount: record.graph.nodes.length }; }
  async indexEntry(projectId, canvas, access) {
    const file = path.join(this.projectDirectory(projectId), ".canvas-index", `${canvas.id}.json`);
    await this.atomic(file, this.summary(canvas), access);
    this.pool.indexes.delete(projectId);
  }
  async listCanvases(projectId, query = {}, access) {
    await this.readProject(projectId, access);
    const limit = Number(query.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new VideoError("每页数量须为 1–100。", 400);
    const search = String(query.search || "").trim().toLocaleLowerCase();
    if (search.length > 200) throw new VideoError("搜索词过长。", 400);
    const fs = checkedFs(access), indexRoot = path.join(this.projectDirectory(projectId), ".canvas-index");
    // The small stamp invalidates caches on other clients without reading graph bodies.
    const stamp = await fs.stat(indexRoot).then(stat => `${stat.mtimeMs}:${stat.ctimeMs}`, absent);
    let cached = this.pool.indexes.get(projectId);
    if (!cached || cached.stamp !== stamp) {
      const names = await fs.readdir(indexRoot).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      const rows = [];
      for (let offset = 0; offset < names.length; offset += 32) {
        const batch = names.slice(offset, offset + 32).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith(".json"));
        rows.push(...await Promise.all(batch.map(name => this.json(path.join(indexRoot, name), access))));
      }
      cached = { stamp, rows: rows.sort((a, b) => a.id.localeCompare(b.id)) };
      if (this.pool.indexes.size >= 8) this.pool.indexes.delete(this.pool.indexes.keys().next().value);
      this.pool.indexes.set(projectId, cached);
    }
    let after = "";
    if (query.cursor) {
      try { const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); if (cursor.projectId !== projectId || cursor.search !== search || !uuid.test(cursor.after)) throw Error(); after = cursor.after; }
      catch { throw new VideoError("分页游标无效。", 400); }
    }
    const rows = cached.rows.filter(row => row.id > after && (!search || row.name.toLocaleLowerCase().includes(search)));
    const items = rows.slice(0, limit), last = items.at(-1);
    return { canvases: items, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ projectId, search, after: last.id })).toString("base64url") : null };
  }
  async saveProject(id, body, access) {
    return this.locked(`project:${this.id(id)}`, access, async () => {
      const previous = await this.readProject(id, access);
      if (body?.revision !== previous.revision) throw new VideoError("项目已更新，请保留编辑并重读。", 409);
      if (body.defaultCanvasId) await this.readCanvas(id, body.defaultCanvasId, access);
      const record = { ...previous, title: typeof body.title === "string" ? body.title.trim().slice(0, 100) || previous.title : previous.title,
        defaultCanvasId: body.defaultCanvasId || previous.defaultCanvasId, revision: previous.revision + 1, updatedAt: now() };
      await this.atomic(path.join(this.projectDirectory(id), "project.json"), record, access); return record;
    });
  }
  async saveCanvas(projectId, canvasId, body, access) {
    return this.locked(`canvas:${this.id(projectId)}:${this.id(canvasId)}`, access, async () => {
      const previous = await this.readCanvas(projectId, canvasId, access);
      if (body?.revision !== previous.revision) throw new VideoError("此画布已更新，请保留编辑并重读。", 409);
      const record = { ...body, id: canvasId, version: 2, revision: previous.revision + 1, updatedAt: now() };
      delete record.externalDependencies;
      try { validateCanvas(record, this.definition); } catch (error) { throw new VideoError(error.message); }
      await this.atomic(path.join(this.canvasDirectory(projectId, canvasId), "canvas.json"), record, access);
      await this.indexEntry(projectId, record, access); return {...record,externalDependencies:externalDependencies(record)};
    });
  }
  async newCanvas(name = "新画布") { return { version: 2, id: randomUUID(), name, revision: 0, updatedAt: now(), workspaceBindingKey: "", variables: [], graph: { nodes: [], edges: [], groups: [] } }; }
  async stageCanvas(directory, record, access) {
    const fs = checkedFs(access);
    await this.safeParent(path.join(directory,"materials","record"),access);
    await fs.mkdir(path.join(directory, "materials"), { recursive: true });
    const persisted={...record};delete persisted.externalDependencies;
    await this.atomic(path.join(directory, "canvas.json"), persisted, access);
  }
  async createProjectV2(body, access) {
    const id = this.id(body?.id);
    return this.locked(`project:${id}`, access, async () => {
      const existing = await this.modern(id, access); if (existing) return existing;
      if (await checkedFs(access).stat(path.join(this.legacyRoot, `${id}.json`)).catch(absent)) throw new VideoError("旧项目需要显式迁移。", 409);
      const pending=await this.json(path.join(this.root,".pending",id,"intent.json"),access).catch(absent);
      const canvas = {...await this.newCanvas(),...(pending?{id:pending.canvasId}:{})}, record = { version: 2, id, title: String(body.title || "未命名项目").slice(0, 100), revision: 0, updatedAt: now(), defaultCanvasId: canvas.id };
      if(!pending)await this.atomic(path.join(this.root,".pending",id,"intent.json"),{canvasId:canvas.id},access);
      await this.publishProjectDirectory(record, canvas, undefined, access); return record;
    });
  }
  async publishProjectDirectory(project, canvas, legacy, access) {
    const fs = checkedFs(access), stage = path.join(this.root, ".pending", project.id);
    await this.safeParent(path.join(stage,"record"),access);
    // Stable transaction location is reused after an interrupted preparation.
    await fs.mkdir(stage, { recursive: true });
    if (legacy) {
      await fs.mkdir(path.join(stage, "migration"), { recursive: true });
      const original = JSON.stringify(legacy);
      await this.atomic(path.join(stage, "migration", "v1-backup.json"), legacy, access);
      await this.atomic(path.join(stage, "migration", "receipt.json"), { sourceRevision: legacy.revision, sha256: digest(original), canvasId: canvas.id }, access);
    }
    await this.stageCanvas(path.join(stage, "canvases", canvas.id), canvas, access);
    await this.atomic(path.join(stage, ".canvas-index", `${canvas.id}.json`), this.summary(canvas), access);
    await this.atomic(path.join(stage, "project.json"), project, access);
    const check = await this.json(path.join(stage, "canvases", canvas.id, "canvas.json"), access);
    if (JSON.stringify(check) !== JSON.stringify(canvas)) throw new VideoError("画布回读校验失败。", 409);
    await fs.rename(stage, this.projectDirectory(project.id));
    this.pool.indexes.delete(project.id);
  }
  async createCanvas(projectId, body, access) {
    this.id(body?.id);
    return this.locked(`canvas:${this.id(projectId)}:${body.id}`, access, async () => {
      await this.readProject(projectId, access);
      const existing = await this.json(path.join(this.canvasDirectory(projectId, body.id), "canvas.json"), access).catch(absent);
      if (existing) return existing;
      const canvas = { ...await this.newCanvas(), id: body.id, name: String(body.name || "新画布").slice(0, 200) };
      return this.publishCanvas(projectId, canvas, undefined, access);
    });
  }
  async importCanvas(projectId,body,access) {
    this.id(body?.id);
    if(body.materials!==undefined&&!Array.isArray(body.materials))throw new VideoError('导入材料必须是数组。');
    const entries=body.materials||[],keys=new Set();let bytes=0;
    if(entries.length>2000)throw new VideoError('导入材料数量超过上限。');
    const materials=entries.map(entry=>{
      const relative=relativeMaterialPath(entry.path);
      if(!relative.startsWith('materials/')||relative==='materials/import-source.json'||keys.has(relative))throw new VideoError('导入材料路径重复或不属于材料目录。');keys.add(relative);
      if(typeof entry.base64!=='string'||entry.base64.length>48*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64))throw new VideoError('导入材料编码无效。');
      const content=Buffer.from(entry.base64,'base64');if(content.toString('base64')!==entry.base64)throw new VideoError('导入材料编码不是规范 Base64。');
      bytes+=content.length;if(content.length>32*1024*1024||bytes>48*1024*1024)throw new VideoError('导入材料超过大小上限。');
      const sha256=digest(content);if(entry.sha256&&entry.sha256!==sha256)throw new VideoError('导入材料摘要不匹配。');
      return {path:relative,content,sha256,bytes:content.length};
    });
    const intent=digest(JSON.stringify({source:body.source,materials:materials.map(({path,sha256,bytes})=>({path,sha256,bytes}))}));
    return this.locked('canvas:'+this.id(projectId)+':'+body.id,access,async()=>{
      await this.readProject(projectId,access);
      const existing=await this.json(path.join(this.canvasDirectory(projectId,body.id),'canvas.json'),access).catch(absent);
      if(existing){if(existing.importRequestHash&&existing.importRequestHash!==intent)throw new VideoError('同一导入身份已用于不同内容。',409);return existing;}
      let converted;try{converted=importWorkbench(body.source,this.definition);}catch(error){throw new VideoError(error.message);}
      const record={...converted.canvas,id:body.id,updatedAt:now(),importRequestHash:intent,importReport:{...converted.report,materials:materials.map(({path,sha256,bytes})=>({path,sha256,bytes}))},importSource:{path:'materials/import-source.json'}};
      const stage=path.join(this.projectDirectory(projectId),'.pending',body.id),fs=checkedFs(access);
      await this.atomic(path.join(stage,'materials','import-source.json'),body.source,access);
      for(const material of materials){const target=path.join(stage,material.path),temp=target+'.'+randomUUID()+'.tmp';await this.safeParent(target,access);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(temp,material.content,{flag:'wx'});await fs.rename(temp,target);if(digest(await fs.readFile(target))!==material.sha256)throw new VideoError('材料写入回读不一致。',409);}
      return this.publishCanvas(projectId,record,undefined,access);
    });
  }
  async exportCanvas(projectId,canvasId,format,access) {
    const record=await this.readCanvas(projectId,canvasId,access);if(format!=="linear")return record;
    if(!record.importSource)throw new VideoError("此画布没有旧线性格式的原始材料。");
    const source=await this.json(await this.material(projectId,canvasId,record.importSource.path,access),access);
    try{return exportLinear(record,source,this.definition);}catch(error){throw new VideoError(error.message);}
  }
  async publishCanvas(projectId, canvas, source, access) {
    const fs = checkedFs(access), stage = path.join(this.projectDirectory(projectId), ".pending", canvas.id);
    await this.stageCanvas(stage, canvas, access);
    if (source) await this.copyMaterials(path.join(source, "materials"), path.join(stage, "materials"), access);
    await fs.rename(stage, this.canvasDirectory(projectId, canvas.id));
    await this.indexEntry(projectId, canvas, access); return canvas;
  }
  async copyMaterials(source, target, access) {
    const fs = checkedFs(access);
    const stat = await fs.lstat(source).catch(absent); if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new VideoError("材料目录不能是符号链接或目录联接。", 400);
    await this.safeParent(path.join(target,"record"),access);await fs.mkdir(target, { recursive: true });
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name), to = path.join(target, entry.name), info = await fs.lstat(from);
      if (info.isSymbolicLink()) throw new VideoError("材料不能引用目录外的链接。", 400);
      if (info.isDirectory()) await this.copyMaterials(from, to, access);
      else if (info.isFile()) {
        await this.safeParent(to,access);const temporary=`${to}.${randomUUID()}.tmp`;
        await fs.copyFile(from,temporary,rawFs.constants.COPYFILE_EXCL);await fs.rename(temporary,to);
      }
      else throw new VideoError("材料包含不支持的文件类型。", 400);
    }
  }
  async copyCanvas(projectId, body, access) {
    this.id(body?.id);
    return this.locked(`canvas:${this.id(projectId)}:${body.id}`, access, async () => {
      await this.readProject(projectId, access);
      const target = path.join(this.canvasDirectory(projectId, body.id), "canvas.json");
      const existing = await this.json(target, access).catch(absent);
      if (existing) { if (existing.copyRequest !== body.requestId) throw new VideoError("副本身份已存在。", 409); return existing; }
      if (typeof body.requestId !== "string" || !uuid.test(body.requestId)) throw new VideoError("复制需要稳定请求身份。", 400);
      let source;
      if (body.sourceCanvasId) source = this.canvasDirectory(body.sourceProjectId || projectId, body.sourceCanvasId);
      else {
        if (typeof body.folderName !== "string" || !/^[a-zA-Z0-9 _().-]{1,160}$/.test(body.folderName) || body.folderName === "." || body.folderName === "..") throw new VideoError("粘贴目录名称无效。", 400);
        source = path.join(this.projectDirectory(projectId), "canvases", body.folderName);
      }
      const fs = checkedFs(access), stat = await fs.lstat(source);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new VideoError("画布来源不能是目录联接。", 400);
      const original = await this.json(path.join(source, "canvas.json"), access);
      try { validateCanvas(original, this.definition); } catch (error) { throw new VideoError(error.message); }
      const cloned = cloneGraph(original.graph, randomUUID);
      const record = { ...original, id: body.id, name: String(body.name || `${original.name} 副本`).slice(0, 200), graph: cloned.graph,
        revision: 0, updatedAt: now(), copyRequest: body.requestId };
      if(record.importReport?.gaps)record.importReport={...record.importReport,gaps:record.importReport.gaps.map(gap=>({...gap,...(cloned.ids.has(gap.nodeId)?{nodeId:cloned.ids.get(gap.nodeId)}:{})}))};
      delete record.runId; delete record.jobId;
      return this.publishCanvas(projectId, record, source, access);
    });
  }
  async migrateProject(projectId, body, access) {
    return this.locked(`project:${this.id(projectId)}`, access, async () => {
      const existing = await this.modern(projectId, access);
      if(existing){if(existing.migration?.phase==="prepared"){if(body?.revision!==existing.migration.sourceRevision)throw new VideoError("恢复迁移需要原来源 revision。",409);return this.finishMigration(existing,access);}return existing;}
      const legacy = await this.json(path.join(this.legacyRoot, `${projectId}.json`), access);
      if (body?.revision !== legacy.revision) throw new VideoError("旧项目已更新，请重读后迁移。", 409);
      const stage = path.join(this.root, ".pending", projectId);
      const receipt = await this.json(path.join(stage, "migration", "receipt.json"), access).catch(absent);
      if (receipt && (receipt.sourceRevision !== legacy.revision || receipt.sha256 !== digest(JSON.stringify(legacy)))) throw new VideoError("迁移准备后旧项目发生变化，请先恢复原迁移。", 409);
      const canvas = { ...await this.newCanvas("原媒体画布"), ...(receipt ? { id: receipt.canvasId } : {}) };
      if(!receipt)await this.atomic(path.join(stage,"migration","receipt.json"),{sourceRevision:legacy.revision,sha256:digest(JSON.stringify(legacy)),canvasId:canvas.id},access);
      const source = legacy.value;
      if (source && source.version !== 1) throw new VideoError("不支持的旧项目版本。", 400);
      const fs = checkedFs(access), directory = path.join(stage, "canvases", canvas.id, "materials");
      await this.safeParent(path.join(directory,"record"),access);
      await fs.mkdir(directory, { recursive: true });
      if (source) {
        // The complete original is recoverable; media editor projection stays in a material, not graph JSON.
        canvas.mediaEditor = { path: "materials/media-editor.json", version: 1 };
        await this.atomic(path.join(directory, "media-editor.json"), source, access);
        canvas.graph.nodes = source.items.map(item => ({ id: item.id, kind: "asset", title: item.title || item.kind,
          config: { mediaKind: item.kind, ...(item.asset ? { assetId: item.asset.id } : {}), legacyCardId: item.id }, layout: source.positions?.[item.id] || { x: 0, y: 0 } }));
      }
      const project = { version: 2, id: projectId, title: legacy.title, revision: legacy.revision + 1, updatedAt: now(), defaultCanvasId: canvas.id,
        migration:{phase:"prepared",sourceRevision:legacy.revision,sourceHash:digest(JSON.stringify(legacy)),machineId:this.runtime.machineId} };
      await this.publishProjectDirectory(project, canvas, legacy, access); return this.finishMigration(project,access);
    });
  }
  async finishMigration(project,access) {
    const receipt=project.migration;
    if(receipt.machineId&&receipt.machineId!==this.runtime.machineId)throw new VideoError("请在原迁移电脑恢复此事务。",423);
    const backup=await this.json(path.join(this.projectDirectory(project.id),"migration","v1-backup.json"),access);
    if(backup.id!==project.id||backup.revision!==receipt.sourceRevision||digest(JSON.stringify(backup))!==receipt.sourceHash)throw new VideoError("原迁移备份摘要不匹配，已保留全部记录。",409);
    const legacyFile=path.join(this.legacyRoot,`${project.id}.json`),source=await this.json(legacyFile,access).catch(absent);
    const fenced=source?.workbenchMigration?.projectId===project.id&&source.workbenchMigration.sourceHash===receipt.sourceHash;
    if(!fenced){
      if(!source||source.revision!==receipt.sourceRevision||digest(JSON.stringify(source))!==receipt.sourceHash)throw new VideoError("原存档在迁移期间发生变化，必须先核对双方记录。",409);
      // A nonnumeric revision makes the original v1 owner reject reads and writes,
      // including a downgraded package that does not know the v2 directory layout.
      await this.atomic(legacyFile,{id:project.id,title:project.title,updatedAt:now(),revision:null,workbenchMigration:{version:2,projectId:project.id,sourceHash:receipt.sourceHash}},access);
    }
    const committed={...project,migration:{...receipt,phase:"committed"}};
    await this.atomic(path.join(this.projectDirectory(project.id),"project.json"),committed,access);return committed;
  }
  async material(projectId, canvasId, relative, access) {
    relativeMaterialPath(relative);
    const fs = checkedFs(access), directory = this.canvasDirectory(projectId, canvasId), root = await fs.realpath(directory), file = await fs.realpath(path.join(directory, relative));
    const rel = path.relative(root, file);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new VideoError("材料引用越出画布目录。", 403);
    return file;
  }
  async rebuildCanvasIndex(projectId, access) {
    return this.locked(`index:${this.id(projectId)}`, access, async () => {
      await this.readProject(projectId, access);
      const names = await checkedFs(access).readdir(path.join(this.projectDirectory(projectId), "canvases")); let count = 0;
      for (const name of names.filter(name => uuid.test(name))) {
        const canvas = await this.readCanvas(projectId, name, access);
        await this.indexEntry(projectId, canvas, access); count++;
      }
      return { count };
    });
  }
  async readMediaEditor(projectId, canvasId, access) {
    const canvas = await this.readCanvas(projectId, canvasId, access);
    let value = canvas.mediaEditor ? await this.json(await this.material(projectId, canvasId, canvas.mediaEditor.path, access), access) : null;
    if (value) {
      const cards = new Map(canvas.graph.nodes.filter(node => node.config.legacyCardId).map(node => [node.config.legacyCardId, node]));
      value.items = value.items.filter(item => cards.has(item.id));
      value.selected=Array.isArray(value.selected)?value.selected.filter(id=>cards.has(id)):[];
      value.positions = Object.fromEntries([...cards].map(([id, node]) => [id, node.layout || { x: 0, y: 0 }]));
      if (!value.items.some(item => item.id === value.active && item.kind === "video")) value.active = value.items.find(item => item.kind === "video")?.id;
      if (!value.active) value = null;
    }
    return { revision: canvas.revision, title: canvas.name, value };
  }
  async saveMediaEditor(projectId, canvasId, body, access) {
    return this.locked(`canvas:${this.id(projectId)}:${this.id(canvasId)}`, access, async () => {
      const canvas = await this.readCanvas(projectId, canvasId, access), value = body?.value;
      if (body?.revision !== canvas.revision) throw new VideoError("此画布已更新，请保留编辑并重读。", 409);
      if (value?.version !== 1 || !Array.isArray(value.items) || !Array.isArray(value.drafts) || !value.items.some(item => item.id === value.active && item.kind === "video")) throw new VideoError("媒体草稿无效。");
      if(value.items.length>projectRules.maxItems||value.items.some(item=>!item||typeof item.id!=="string"||!projectRules.kinds.includes(item.kind))||new Set(value.items.map(item=>item.id)).size!==value.items.length)throw new VideoError("媒体卡片无效。");
      if(typeof body.title==="string"&&body.title.trim())canvas.name=body.title.trim().slice(0,200);
      const previous = new Map(canvas.graph.nodes.filter(node => node.config.legacyCardId).map(node => [node.config.legacyCardId, node]));
      const other = canvas.graph.nodes.filter(node => !node.config.legacyCardId);
      const media = value.items.map(item => ({ ...(previous.get(item.id) || {}), id: previous.get(item.id)?.id || item.id, kind: "asset", title: item.title || item.kind,
        config: { ...(previous.get(item.id)?.config || {}), mediaKind: item.kind, legacyCardId: item.id, ...(item.asset ? { assetId: item.asset.id } : {}) }, layout: value.positions?.[item.id] || { x: 0, y: 0 } }));
      canvas.graph.nodes = [...other, ...media];
      // A media-only edit cannot silently remove workflow data dependencies.
      try { validateCanvas(canvas, this.definition); } catch (error) { throw new VideoError(error.message); }
      // Immutable material versions ensure a failed publication leaves the previous revision readable.
      const material = `materials/media-editor-${randomUUID()}.json`;
      await this.atomic(path.join(this.canvasDirectory(projectId, canvasId), material), value, access);
      canvas.mediaEditor = { path: material, version: 1 }; canvas.revision++; canvas.updatedAt = now();
      delete canvas.externalDependencies;
      await this.atomic(path.join(this.canvasDirectory(projectId, canvasId), "canvas.json"), canvas, access);
      await this.indexEntry(projectId, canvas, access); return { revision: canvas.revision };
    });
  }
}
