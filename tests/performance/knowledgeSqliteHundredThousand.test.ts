import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { KnowledgeSqlitePrototype, type SqliteKnowledgeQuery, type SqliteKnowledgeRow } from "./knowledgeSqlitePrototype.js";
import { syntheticKnowledgeRow } from "./knowledgeSqliteSyntheticFixture.js";

function matches(row:SqliteKnowledgeRow,query:SqliteKnowledgeQuery):boolean {
  return row.text.includes(query.text)&&(query.kind===undefined||row.kind===query.kind)
    &&(query.status===undefined||row.status===query.status)&&(query.archived===true||!row.archived)
    &&(query.tag===undefined||row.tags.includes(query.tag));
}
function compare(a:SqliteKnowledgeRow,b:SqliteKnowledgeRow):number {
  return a.updatedAt>b.updatedAt?-1:a.updatedAt<b.updatedAt?1:a.id<b.id?-1:a.id>b.id?1:0;
}
function reference(rows:Map<string,SqliteKnowledgeRow>,query:SqliteKnowledgeQuery) {
  const items=[...rows.values()].filter(row=>matches(row,query)).sort(compare);
  const facets:Record<string,number>={};for(const row of items)facets[row.status]=(facets[row.status]??0)+1;
  return {items,facets,total:items.length};
}
function assertPage(actual:ReturnType<KnowledgeSqlitePrototype["search"]>,expected:ReturnType<typeof reference>,offset=0) {
  assert.equal(actual.total,expected.total);
  assert.deepEqual(Object.fromEntries(actual.facets.map(item=>[item.status,Number(item.count)])),expected.facets);
  assert.deepEqual(actual.items.map(item=>({id:item.id,updatedAt:item.updatedAt})),expected.items.slice(offset,offset+8).map(item=>({id:item.id,updatedAt:item.updatedAt})));
}
// Independent literal SQL predicate: deliberately no posting/FTS candidate.
function rawPredicate(query:SqliteKnowledgeQuery) {
  const clauses=["instr(d.text,?)>0"];const parameters:(string|number)[]=[query.text];
  for(const key of ["kind","status"] as const)if(query[key]!==undefined){clauses.push(`d.${key}=?`);parameters.push(query[key]!);}
  if(!query.archived)clauses.push("d.archived=0");
  if(query.tag!==undefined){clauses.push("EXISTS(SELECT 1 FROM tags t WHERE t.id=d.id AND t.tag=?)");parameters.push(query.tag);}
  return {sql:clauses.join(" AND "),parameters};
}

test("100k representative integer index single-connection sequential acceptance",{skip:process.env.KNOWLEDGE_INTEGER_BENCHMARK!=="100000"},()=>{
  const directory=process.env.KNOWLEDGE_INTEGER_ARTIFACT_DIR;
  assert.ok(directory,"explicit unused private artifact directory required");
  assert.equal(fs.existsSync(directory),false,"never overwrite a retained experiment");
  const space=fs.statfsSync(path.dirname(directory));
  const freeBytes=space.bavail*space.bsize;
  assert.ok(freeBytes>=8*1024**3,"require at least 8 GiB free for this bounded 100k experiment");
  fs.mkdirSync(directory);
  const file=path.join(directory,"index.sqlite");
  const index=new KnowledgeSqlitePrototype(file);
  fs.writeFileSync(path.join(directory,"started.json"),JSON.stringify({phase:"building",schemaVersion:2,targetRows:100000,startedAt:new Date().toISOString(),node:process.version,freeBytes,artifactLimitBytes:5*1024**3}),{flag:"wx"});
  const rows=new Map<string,SqliteKnowledgeRow>();
  const memorySamples:{stage:string;rss:number;heapUsed:number}[]=[];
  const memory=(stage:string)=>{const usage=process.memoryUsage();memorySamples.push({stage,rss:usage.rss,heapUsed:usage.heapUsed});};
  const sourceHash=createHash("sha256");let textBytes=0,serializedBytes=0;
  try {
    memory("before-build");const began=performance.now();
    for(let offset=0;offset<100000;offset+=500) {
      index.transaction(()=>{for(let i=offset;i<offset+500;i++){
        const row=syntheticKnowledgeRow(i);const serialized=JSON.stringify(row)+"\n";
        sourceHash.update(serialized);textBytes+=Buffer.byteLength(row.text);serializedBytes+=Buffer.byteLength(serialized);
        rows.set(row.id,row);index.upsert(row);
      }});
      const artifactBytes=[file,`${file}-wal`,`${file}-shm`].reduce((sum,name)=>sum+(fs.existsSync(name)?fs.statSync(name).size:0),0);
      assert.ok(artifactBytes<=5*1024**3,"artifact budget exceeded 5 GiB; stop generating and retain failure evidence");
      const available=fs.statfsSync(directory);assert.ok(available.bavail*available.bsize>=8*1024**3,"free-space reserve fell below 8 GiB");
      assert.ok(process.memoryUsage().rss<=3*1024**3,"sampled RSS exceeded the 3 GiB experimental budget");
      assert.ok(performance.now()-began<=300000,"bounded build exceeded five minutes; retain partial artifact for diagnosis");
      if(offset%5000===0)memory(`build-${offset+500}`);
    }
    const buildMs=performance.now()-began;memory("after-build");
    index.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const afterBuildBytes={database:fs.statSync(file).size,wal:fs.existsSync(`${file}-wal`)?fs.statSync(`${file}-wal`).size:0,shm:fs.existsSync(`${file}-shm`)?fs.statSync(`${file}-shm`).size:0};
    const queries:SqliteKnowledgeQuery[]=[
      {text:"",kind:"recent"},{text:"",archived:true},{text:"中",archived:true},{text:"中文",archived:true},
      {text:"中文合",archived:true},{text:"%_",archived:true},{text:"literal%_",kind:"recent"},
      {text:"bucket17",archived:true},{text:"token-000123",archived:true},
      {text:"中文",kind:"plan",status:"open",tag:"group2"},{text:"token-099999",kind:"recent",archived:true},{text:"not-present-anywhere"}
    ];
    const matrix=queries.map(query=>{
      const referenceStart=performance.now();const expected=reference(rows,query);const referenceMs=performance.now()-referenceStart;
      const raw=rawPredicate(query);const oracleStart=performance.now();
      const oracle=index.readSnapshot(()=>({
        total:Number(index.db.prepare(`SELECT count(*) AS n FROM documents d WHERE ${raw.sql}`).get(...raw.parameters)!.n),
        facets:index.db.prepare(`SELECT status,count(*) AS count FROM documents d WHERE ${raw.sql} GROUP BY status ORDER BY status`).all(...raw.parameters),
        items:index.db.prepare(`SELECT id,updatedAt FROM documents d WHERE ${raw.sql} ORDER BY updatedAt DESC,id ASC LIMIT ?`).all(...raw.parameters,8)
      }));
      assertPage(oracle,expected);const oracleMs=performance.now()-oracleStart;
      const samplesMs=[];for(let repeat=0;repeat<5;repeat++){const started=performance.now();const result=index.search(query,8);samplesMs.push(performance.now()-started);assertPage(result,expected);}
      const predicate=index.predicate(query);
      const phases=Object.entries({facets:`SELECT status,count(*) AS count FROM documents d WHERE ${predicate.sql} GROUP BY status ORDER BY status`,page:`SELECT id,updatedAt FROM ${index.pageSource(query)} WHERE ${predicate.sql} ORDER BY updatedAt DESC,id ASC LIMIT ?`}).map(([phase,sql])=>{
        const parameters=phase==="page"?[...predicate.parameters,8]:predicate.parameters;const started=performance.now();index.db.prepare(sql).all(...parameters);
        return {phase,ms:performance.now()-started,plan:index.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)};
      });
      memory(`query-${query.text||"empty"}`);
      return {query,total:expected.total,referenceMs,oracleMs,samplesMs,medianMs:[...samplesMs].sort((a,b)=>a-b)[2],phases};
    });
    const pageQuery={text:"",kind:"recent"};const expectedPages=reference(rows,pageQuery);
    let after:{updatedAt:string;id:string}|undefined;const continuous=[];
    for(let page=0;page<10;page++){
      const started=performance.now();const result=index.search(pageQuery,8,after);const ms=performance.now()-started;
      assertPage(result,expectedPages,page*8);const last=result.items.at(-1)!;after={updatedAt:String(last.updatedAt),id:String(last.id)};
      continuous.push({offset:page*8,ms});
    }
    const deep=[0.5,0.9].map(fraction=>{
      const offset=Math.floor(expectedPages.total*fraction),previous=expectedPages.items[offset-1]!;
      const cursor={updatedAt:previous.updatedAt,id:previous.id};const samplesMs=[];
      for(let repeat=0;repeat<3;repeat++){const started=performance.now();const result=index.search(pageQuery,8,cursor);samplesMs.push(performance.now()-started);assertPage(result,expectedPages,offset);}
      return {offset,cursor,samplesMs};
    });
    const operations=[];
    const mutate=(name:string,action:()=>void,query:SqliteKnowledgeQuery)=>{
      const started=performance.now();index.transaction(action);const commitMs=performance.now()-started;
      const expected=reference(rows,query);const readStarted=performance.now();const result=index.search(query,8);const readMs=performance.now()-readStarted;assertPage(result,expected);
      operations.push({name,commitMs,readMs,total:result.total});
    };
    const extra={...syntheticKnowledgeRow(100001),id:"synthetic-extra",text:"新增 独立验证"};
    mutate("insert",()=>{index.upsert(extra);rows.set(extra.id,extra);},{text:"新增",archived:true});
    const changed={...rows.get("synthetic-000123")!,text:"修改 中文合 distinct-update"};
    const oldDocid=index.db.prepare("SELECT docid FROM documents WHERE id=?").get(changed.id)!.docid;
    mutate("update",()=>{index.upsert(changed);rows.set(changed.id,changed);},{text:"修改",archived:true});
    assert.equal(index.db.prepare("SELECT docid FROM documents WHERE id=?").get(changed.id)!.docid,oldDocid);
    const removed=rows.get("synthetic-000124")!;const removedDocid=Number(index.db.prepare("SELECT docid FROM documents WHERE id=?").get(removed.id)!.docid);
    mutate("delete",()=>{index.remove(removed.id);rows.delete(removed.id);},{text:"token-000124",archived:true});
    const restored={...removed,text:"重插 中文合 distinct-reinsert"};
    mutate("reinsert",()=>{index.upsert(restored);rows.set(restored.id,restored);},{text:"重插",archived:true});
    assert.ok(Number(index.db.prepare("SELECT docid FROM documents WHERE id=?").get(restored.id)!.docid)>removedDocid);
    mutate("remove-extra",()=>{index.remove(extra.id);rows.delete(extra.id);},{text:"新增",archived:true});
    assert.deepEqual(index.db.prepare("PRAGMA foreign_key_check").all(),[]);
    index.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");memory("after-mutations");
    const report={experiment:"100k-integer-single-connection",node:process.version,sqlite:index.db.prepare("SELECT sqlite_version() AS version").get(),schemaVersion:index.db.prepare("PRAGMA user_version").get(),
      hardware:{cpu:os.cpus()[0]?.model,logicalProcessors:os.cpus().length,totalMemory:os.totalmem(),freeMemoryAfter:os.freemem(),freeDiskBefore:freeBytes},
      source:{rows:100000,textBytes,serializedBytes,sha256:sourceHash.digest("hex"),generator:"knowledgeSqliteSyntheticFixture.ts"},
      schema:index.db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),buildMs,afterBuildBytes,
      finalBytes:{database:fs.statSync(file).size,wal:fs.existsSync(`${file}-wal`)?fs.statSync(`${file}-wal`).size:0,shm:fs.existsSync(`${file}-shm`)?fs.statSync(`${file}-shm`).size:0},
      pageUsage:index.db.prepare("SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all(),
      shortPostingRows:Number(index.db.prepare("SELECT count(*) AS n FROM short_terms").get()!.n),memorySamples,observedMaxRss:Math.max(...memorySamples.map(item=>item.rss)),
      conditions:{artifactLimitBytes:5*1024**3,minimumFreeDiskBytes:8*1024**3,rssLimitBytes:3*1024**3,buildLimitMs:300000,queryConnections:1,parallelReaders:0,cache:"same process after build; independent raw SQL oracle precedes each 5-sample search series; no cold flush",percentiles:"medians only; samples insufficient for tail claims",memory:"sampled RSS, not a strict peak; includes the independent source-map oracle"},matrix,continuous,deep,operations,
      limitations:["normalized knowledge text, not production field-wise plan matching","only updatedAt DESC,id ASC","no cross-request cursor revision","no source-file external reconciliation or production API acceptance"]};
    fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2),{flag:"wx"});
    index.close();
    const reopened=new DatabaseSync(file,{readOnly:true});
    try {assert.equal(Number(reopened.prepare("SELECT count(*) AS n FROM documents").get()!.n),100000);assert.equal(reopened.prepare("SELECT text FROM documents WHERE id=?").get(changed.id)!.text,changed.text);} finally {reopened.close();}
    fs.writeFileSync(path.join(directory,"completion.json"),JSON.stringify({success:true,readOnlyReopenVerified:true,rows:100000,finishedAt:new Date().toISOString()}),{flag:"wx"});
    console.log(JSON.stringify({artifactDirectory:directory,buildMs,bytes:report.finalBytes,observedMaxRss:report.observedMaxRss,matrix:matrix.map(item=>({query:item.query,total:item.total,samplesMs:item.samplesMs,medianMs:item.medianMs})),continuous,deep,operations}));
  } catch(error) {
    try {index.close();} catch {}
    fs.writeFileSync(path.join(directory,"failure.json"),JSON.stringify({error:String(error),rowsConstructed:rows.size,memorySamples}),{flag:"wx"});
    throw error;
  }
});
