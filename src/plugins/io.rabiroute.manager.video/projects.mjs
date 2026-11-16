import { projectFields, projectRules } from "./contracts.mjs";
import {checkedFs} from './requestAccess.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VideoError} from './service.mjs';
import {WorkbenchProjects} from './workbenchProjects.mjs';
import definition from './workbench-definition.json' with {type:'json'};

export class VideoProjects extends WorkbenchProjects {
  constructor(runtime) { super(runtime,definition); this.serial=Promise.resolve(); this.recordIssues=[]; }
  file(id) { if(!new RegExp(projectFields.id.pattern).test(id)) throw new VideoError('项目不存在。',404); return path.join(this.legacyRoot,`${id}.json`); }
  async read(id,access) {
    this.file(id);
    if(await this.modern(id,access)) throw new VideoError('此项目已升级为工作台画布，请更新客户端后打开。',426);
    const fs=checkedFs(access);
    try {
      const value=JSON.parse(await fs.readFile(this.file(id),'utf8'));
      if (!value || String(value.id) !== String(id) || typeof value.title !== 'string' || typeof value.updatedAt !== 'string'
        || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new VideoError('原项目记录损坏，请恢复原文件后再编辑。',409);
      return value;
    }
    catch(error) { if(error.code==='ENOENT') throw new VideoError('项目不存在。',404); throw error; }
  }
  async list(access) {
    const fs=checkedFs(access);
    const names=await fs.readdir(this.legacyRoot).catch(error=>{if(error.code==='ENOENT') return [];throw error;});
    const modernNames=this.root===this.legacyRoot?names:await fs.readdir(this.root).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
    const projects=[], issues=[];
    for (const name of names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name))) {
      try { if(await this.modern(name.slice(0,-5),access)) continue; projects.push(await this.read(name.slice(0,-5),access)); }
      catch { access?.assert(); issues.push({id:name.slice(0,-5),scope:'projects',code:'unreadable_record'}); }
    }
    access?.assert(); this.recordIssues=issues;
    const summaries=projects.map(({id,title,updatedAt,revision,value})=>({id,title,updatedAt,revision,version:1,cardCount:Array.isArray(value?.items)?value.items.length:0}));
    for(const name of modernNames.filter(name=>/^[a-f0-9-]{36}$/.test(name))) {
      try {const record=await this.readProject(name,access,true);summaries.push({...record,cardCount:0,...(record.migration?.phase==='prepared'?{migrationPending:true,migrationSourceRevision:record.migration.sourceRevision}:{})});}
      catch {access?.assert();issues.push({id:name,scope:'projects',code:'unreadable_record'});}
    }
    return summaries.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  mutate(operation,access,key='legacy') {
    access?.assert();
    if(this.runtime.readOnly) throw new VideoError('当前服务只读，无法保存项目。',423);
    return this.locked(key,access,operation);
  }
  async publish(project,access) {
    const fs=checkedFs(access);
    await fs.mkdir(this.legacyRoot,{recursive:true});
    const target=this.file(project.id), temp=`${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp,JSON.stringify(project),{flag:'wx'});
    await fs.rename(temp,target);return project;
  }
  create(body,access) { return this.mutate(async()=>{
    this.file(body?.id);
    const existing=await this.read(body.id,access).catch(error=>{if(error.status===404) return undefined;throw error;});
    if(existing) return existing;
    return this.publish({id:body.id,title:'未命名项目',revision:0,updatedAt:new Date().toISOString(),value:null},access);
  },access,`project:${body?.id}`); }
  save(id,body,access) { return this.mutate(async()=>{
    const previous=await this.read(id,access);
    if(!Number.isSafeInteger(body?.revision)||body.revision!==previous.revision) throw new VideoError('项目已被另一页面更新，请保留当前编辑后重新打开项目。',409);
    const value=body.value;
    if(value?.version!==projectRules.version || !Array.isArray(value.items) || value.items.length>projectRules.maxItems || !Array.isArray(value.drafts) || !value.items.some(item=>item.id===value.active && item.kind==='video')) throw new VideoError('项目内容无效。');
    if(value.items.some(item=>!item || typeof item.id!=='string' || !projectRules.kinds.includes(item.kind)) || new Set(value.items.map(item=>item.id)).size!==value.items.length) throw new VideoError('项目卡片无效。');
    const title=typeof body.title==='string'?body.title.trim().slice(0,projectFields.title.normalizedMaxLength):previous.title;
    return this.publish({id,title:title||'未命名项目',revision:previous.revision+1,updatedAt:new Date().toISOString(),value},access);
  },access,`project:${id}`); }
}
