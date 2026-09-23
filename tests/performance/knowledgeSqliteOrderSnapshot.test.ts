import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeSqlitePrototype, type SqliteKnowledgeQuery, type SqliteKnowledgeRow } from "./knowledgeSqlitePrototype.js";

function row(i:number):SqliteKnowledgeRow {
  return {id:`row-${String(i).padStart(6,"0")}`,text:`synthetic 中文 literal%_ token-${String(i).padStart(6,"0")} bucket${i%16}`,
    kind:i%2?"recent":"plan",status:i%3?"open":"done",archived:i%7===0,updatedAt:`2026-01-${String(i%28+1).padStart(2,"0")}`,tags:[`group${i%4}`]};
}
function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"knowledge-sqlite-ordered-"));
  const file=path.join(directory,"synthetic.sqlite");
  const index=new KnowledgeSqlitePrototype(file);
  return {directory,file,index,close(){index.close();fs.rmSync(directory,{recursive:true,force:true});}};
}
function oracle(index:KnowledgeSqlitePrototype,query:SqliteKnowledgeQuery,limit=8) {
  const predicate=index.predicate(query);
  const where=predicate.sql.replace("d.rowid IN (SELECT rowid FROM fulltext","d.id IN (SELECT id FROM fulltext");
  return index.readSnapshot(()=>({
    total:Number(index.db.prepare(`SELECT count(*) AS n FROM documents d WHERE ${where}`).get(...predicate.parameters)!.n),
    facets:index.db.prepare(`SELECT status,count(*) AS count FROM documents d WHERE ${where} GROUP BY status ORDER BY status`).all(...predicate.parameters),
    items:index.db.prepare(`SELECT id,updatedAt FROM documents d WHERE ${where} ORDER BY updatedAt DESC,id ASC LIMIT ?`).all(...predicate.parameters,limit)
  }));
}

test("ordered page candidates avoid temporary sorting and match the old SQL oracle",()=>{
  const f=fixture();
  try {
    f.index.transaction(()=>{for(let i=0;i<128;i++)f.index.upsert(row(i));});
    const cases:SqliteKnowledgeQuery[]=[{text:"",kind:"recent"},{text:"",kind:"plan",archived:true},{text:"literal%_",kind:"recent"},{text:"中文",kind:"plan",status:"open",tag:"group2"}];
    const plans=[];
    for(const query of cases) {
      const p=f.index.predicate(query);
      const plan=f.index.db.prepare(`EXPLAIN QUERY PLAN SELECT id,updatedAt FROM ${f.index.pageSource(query)} WHERE ${p.sql} ORDER BY updatedAt DESC,id ASC LIMIT ?`).all(...p.parameters,8);
      assert.ok(plan.every(item=>!String(item.detail).includes("TEMP B-TREE")));
      if(!query.text) assert.ok(plan.some(item=>String(item.detail).includes("COVERING INDEX")));
      assert.deepEqual(f.index.search(query,8),oracle(f.index,query));
      const first=f.index.search(query,3);
      if(first.items.length) {
        const last=first.items.at(-1)!;
        const next=f.index.search(query,3,{id:String(last.id),updatedAt:String(last.updatedAt)});
        assert.equal(new Set([...first.items,...next.items].map(item=>item.id)).size,first.items.length+next.items.length);
      }
      plans.push({query,plan});
    }
    console.log(JSON.stringify({experiment:"ordered-pages",plans}));
  } finally {f.close();}
});

test("facets and page retain one read snapshot across a committed second connection",t=>{
  const f=fixture();const writer=new KnowledgeSqlitePrototype(f.file);
  try {
    f.index.transaction(()=>f.index.upsert(row(1)));
    const query={text:"synthetic",kind:"recent"};
    const before=oracle(f.index,query);
    const prepare=f.index.db.prepare.bind(f.index.db);let inserted=false;
    const hook=t.mock.method(f.index.db,"prepare",(sql:string)=>{
      if(sql.startsWith("SELECT id,updatedAt")&&!inserted) {
        inserted=true;writer.transaction(()=>writer.upsert({...row(3),updatedAt:"2027-01-01"}));
      }
      return prepare(sql);
    });
    assert.deepEqual(f.index.search(query,8),before,"writer commits between facets and page, but both must see the old snapshot");
    hook.mock.restore();
    assert.equal(f.index.search(query,8).total,2,"a new search must see the committed writer");
    assert.equal(Number(f.index.db.prepare("PRAGMA query_only").get()!.query_only),0);
    assert.throws(()=>f.index.readSnapshot(()=>{f.index.db.exec("UPDATE documents SET status='changed'");}),/readonly/i);
    assert.throws(()=>f.index.readSnapshot(()=>{throw new Error("injected read failure");}),/injected read failure/);
    f.index.transaction(()=>f.index.upsert(row(5)));
    assert.equal(f.index.search(query,8).total,3,"write works after error rollback and query_only restoration");
    f.index.db.exec("BEGIN IMMEDIATE");
    f.index.upsert(row(9));
    assert.equal(f.index.readSnapshot(()=>f.index.readSnapshot(()=>f.index.search(query,8).total)),4);
    assert.throws(()=>f.index.readSnapshot(()=>f.index.readSnapshot(()=>{throw new Error("nested failure");})),/nested failure/);
    assert.equal(Number(f.index.db.prepare("PRAGMA query_only").get()!.query_only),0);
    assert.equal(Number(writer.db.prepare("SELECT count(*) AS n FROM documents").get()!.n),3,"nested reads must not commit their caller's write transaction");
    f.index.db.exec("ROLLBACK");
    assert.equal(f.index.search(query,8).total,3);
    f.index.db.exec("SAVEPOINT knowledge_search");
    f.index.upsert(row(11));
    assert.equal(f.index.search(query,8).total,4);
    f.index.db.exec("ROLLBACK TO knowledge_search; RELEASE knowledge_search");
    assert.equal(f.index.search(query,8).total,3,"the caller's pre-existing savepoint must remain addressable");
    f.index.db.exec("PRAGMA query_only=ON; BEGIN");
    assert.equal(f.index.search(query,8).total,3);
    assert.equal(Number(f.index.db.prepare("PRAGMA query_only").get()!.query_only),1);
    f.index.db.exec("ROLLBACK; PRAGMA query_only=OFF");
  } finally {writer.close();f.close();}
});

test("cleanup failure preserves the original error, restores flags and fails closed",t=>{
  const f=fixture();
  try {
    f.index.transaction(()=>f.index.upsert(row(1)));
    f.index.db.exec("SAVEPOINT caller_owned");
    const exec=f.index.db.exec.bind(f.index.db);let injected=false;
    const hook=t.mock.method(f.index.db,"exec",(sql:string)=>{
      if(sql==="PRAGMA query_only=OFF"&&!injected){injected=true;throw new Error("injected restore failure");}
      return exec(sql);
    });
    assert.throws(()=>f.index.readSnapshot(()=>{throw new Error("original query failure");}),error=>{
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.cause),/original query failure/);
      assert.ok(error.errors.some(item=>String(item).includes("injected restore failure")));
      return true;
    });
    hook.mock.restore();
    assert.equal(Number(f.index.db.prepare("PRAGMA query_only").get()!.query_only),0);
    f.index.db.exec("ROLLBACK TO caller_owned; RELEASE caller_owned");
    assert.throws(()=>f.index.search({text:""}),/discard this connection/);
  } finally {f.close();}
});

test("bounded 10k sequential matrix and short-posting space accounting",{skip:process.env.SQLITE_ORDER_BENCHMARK!=="10000"},()=>{
  const evidenceFile=process.env.SQLITE_ORDER_EVIDENCE_FILE;
  assert.ok(evidenceFile,"an explicit unused private evidence output is required before constructing the benchmark");
  assert.equal(fs.existsSync(evidenceFile),false,"never overwrite an earlier benchmark receipt");
  const f=fixture();
  try {
    const started=performance.now();let textBytes=0;
    for(let begin=0;begin<10000;begin+=250) f.index.transaction(()=>{
      for(let i=begin;i<begin+250;i++){const value=row(i);textBytes+=Buffer.byteLength(value.text);f.index.upsert(value);}
    });
    const buildMs=performance.now()-started;
    f.index.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const queries:SqliteKnowledgeQuery[]=[{text:"",kind:"recent"},{text:"literal%_",kind:"recent"},{text:"中"},{text:"%_",archived:true},{text:"token-000123",archived:true},{text:"token-009999",kind:"recent",archived:true},{text:"not-present"}];
    const results=queries.map(query=>{
      const expected=oracle(f.index,query);const samples=[];
      for(let i=0;i<3;i++){const start=performance.now();assert.deepEqual(f.index.search(query,8),expected);samples.push(performance.now()-start);}
      const p=f.index.predicate(query);
      const sql={facets:`SELECT status,count(*) AS count FROM documents d WHERE ${p.sql} GROUP BY status ORDER BY status`,page:`SELECT id,updatedAt FROM ${f.index.pageSource(query)} WHERE ${p.sql} ORDER BY updatedAt DESC,id ASC LIMIT ?`};
      const phases=Object.entries(sql).map(([phase,statement])=>{const params=phase==="page"?[...p.parameters,8]:p.parameters;const start=performance.now();f.index.db.prepare(statement).all(...params);return {phase,ms:performance.now()-start,plan:f.index.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params)};});
      return {query,total:expected.total,samplesMs:samples,phases};
    });
    const fileBytes=fs.statSync(f.file).size;
    const shortTerms=Number(f.index.db.prepare("SELECT count(*) AS n FROM short_terms").get()!.n);
    const shortPayloadBytes=Number(f.index.db.prepare("SELECT sum(length(CAST(term AS BLOB)) + CASE WHEN docid<=1 THEN 0 WHEN docid<=127 THEN 1 WHEN docid<=32767 THEN 2 WHEN docid<=8388607 THEN 3 WHEN docid<=2147483647 THEN 4 WHEN docid<=140737488355327 THEN 6 ELSE 8 END) AS n FROM short_terms").get()!.n);
    const walBytes=fs.existsSync(`${f.file}-wal`)?fs.statSync(`${f.file}-wal`).size:0;
    const shmBytes=fs.existsSync(`${f.file}-shm`)?fs.statSync(`${f.file}-shm`).size:0;
    let pageUsage:unknown;
    try {pageUsage=f.index.db.prepare("SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all();}
    catch(error){pageUsage={unavailable:String(error)};}
    const report={experiment:"bounded-10k-sequential",node:process.version,sqlite:f.index.db.prepare("SELECT sqlite_version() AS version").get(),rows:10000,buildMs,textBytes,fileBytes,walBytes,shmBytes,storageTextRatio:fileBytes/textBytes,shortTerms,shortPayloadBytes,pageUsage,results};
    fs.writeFileSync(evidenceFile,JSON.stringify(report,null,2),{flag:"wx"});
    console.log(JSON.stringify(report));
  } finally {f.close();}
});
