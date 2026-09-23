import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeSqlitePrototype, type SqliteKnowledgeQuery } from "./knowledgeSqlitePrototype.js";

// Bounded, single-connection diagnostics. No production imports or large-run switch.
test("profile exact count/facets/page and compare rowid candidates without concurrency",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"sqlite-query-plan-"));
  const index=new KnowledgeSqlitePrototype(path.join(directory,"index.sqlite"));
  try {
    const start=performance.now();
    index.transaction(()=>{
      for(let i=0;i<512;i++) index.upsert({id:`row-${String(i).padStart(6,"0")}`,
        text:`synthetic 中文 literal%_ token-${String(i).padStart(6,"0")} bucket${i%16}`,
        kind:i%2?"recent":"plan",status:i%3?"open":"done",archived:i%7===0,
        updatedAt:"2026-01-01",tags:[`group${i%4}`]});
    });
    const buildMs=performance.now()-start;
    const queries:SqliteKnowledgeQuery[]=[{text:"token-000123",archived:true},{text:"bucket7"},{text:"literal%_",kind:"recent"},{text:"中"},{text:"%_",archived:true},{text:"not-present"},{text:"中文",kind:"plan",status:"open",tag:"group2"},{text:""}];
    const results=[];
    for(const query of queries) {
      const predicate=index.predicate(query);
      const original=predicate.sql.replace("d.rowid IN (SELECT rowid FROM fulltext", "d.id IN (SELECT id FROM fulltext");
      const rowid=original.replace("d.id IN (SELECT id FROM fulltext", "d.rowid IN (SELECT rowid FROM fulltext");
      const variants=[];
      for(const [name,where] of [["baseline",original],["rowid",rowid]] as const) {
        const statements={
          count:`SELECT count(*) AS count FROM documents d WHERE ${where}`,
          facets:`SELECT status,count(*) AS count FROM documents d WHERE ${where} GROUP BY status ORDER BY status`,
          page:`SELECT id,updatedAt FROM documents d WHERE ${where} ORDER BY updatedAt DESC,id ASC LIMIT ?`
        };
        const phases:Record<string,unknown>={};
        const values:Record<string,any>={};
        for(const [phase,sql] of Object.entries(statements)) {
          const parameters=phase==="page"?[...predicate.parameters,8]:predicate.parameters;
          const plan=index.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters);
          const statement=index.db.prepare(sql);
          const samples=[];
          for(let repeat=0;repeat<3;repeat++) {
            const began=performance.now();
            values[phase]=statement.all(...parameters);
            samples.push(performance.now()-began);
          }
          phases[phase]={sql,plan,samplesMs:samples};
        }
        const total=Number(values.count[0].count);
        const facetTotal=values.facets.reduce((sum:number,item:{count:number|bigint})=>sum+Number(item.count),0);
        assert.equal(facetTotal,total,"full status facets must sum to the exact count");
        variants.push({name,total,facets:values.facets,items:values.page,phases});
      }
      assert.deepEqual(variants[1]!.items,variants[0]!.items);
      assert.deepEqual(variants[1]!.facets,variants[0]!.facets);
      assert.equal(variants[1]!.total,variants[0]!.total);
      assert.deepEqual(index.search(query,8),{total:variants[0]!.total,facets:variants[0]!.facets,items:variants[0]!.items});
      results.push({query,variants});
    }
    console.log(JSON.stringify({scope:"synthetic-512-single-connection",node:process.version,sqlite:index.db.prepare("select sqlite_version() as version").get(),buildMs,results}));
    const broad=results.find(item=>item.query.text==="literal%_")!;
    console.log(JSON.stringify({broadQuerySummary:broad.variants.map(variant=>({name:variant.name,total:variant.total,phases:Object.fromEntries(Object.entries(variant.phases).map(([phase,value])=>{
      const detail=value as {samplesMs:number[];plan:Array<{detail:string}>};
      return [phase,{samplesMs:detail.samplesMs,plan:detail.plan.map(item=>item.detail)}];
    }))}))}));
  } finally { index.close();fs.rmSync(directory,{recursive:true,force:true}); }
});
