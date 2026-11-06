import assert from "node:assert/strict";
import test from "node:test";
import { vacuumGridContracts, type decodeXiaomiVacuumMap } from "./vacuumMapDecoder.js";
import { planVacuumMapPath } from "./vacuumPath.js";

function fixture() {
  const cells=Buffer.alloc(40*40,3), extra=Buffer.alloc(cells.length);
  const map:Record<string,any>={task_id:1,paths:{pose_id:7}};
  const data:ReturnType<typeof decodeXiaomiVacuumMap>={decoded:true,format:"xiaomi-json-envelope-v2",map,
    grid:{encoding:"uint8-row-major",dataBase64:cells.toString("base64"),additionalDataBase64:extra.toString("base64"),width:40,height:40,mapId:1,originX:0,originY:0,resolution:100,rotation:0,unit:"millimeters",rowZero:"originY",labels:vacuumGridContracts["xiaomi.vacuum.pv11cn"],cellSemanticsVerified:true},
    rooms:[],robotPosition:{x:850,y:2050},dockPosition:undefined,poseFreshness:"unverified",coordinateNavigation:false};
  return {data,cells,extra,update(){data.grid.dataBase64=cells.toString("base64");data.grid.additionalDataBase64=extra.toString("base64");}};
}

test("path keeps exact endpoints, model semantics, snapshot freshness and zero motion",()=>{
  const f=fixture();f.cells.fill(255);f.update();
  const p=planVacuumMapPath(f.data,{x:3055,y:2044});
  assert.deepEqual(p.waypoints[0],f.data.robotPosition);assert.deepEqual(p.waypoints.at(-1),p.target);
  assert.equal(p.poseId,7);assert.equal(p.poseFreshness,"unverified");assert.equal(p.coordinateNavigation,false);assert.equal(p.movementCommandsSent,0);
  assert.ok(p.lengthMm>=2200);
});

test("wall value 1 forces a detour with clearance; no path crosses its inflated boundary",()=>{
  const f=fixture();for(let y=8;y<=30;y++)f.cells[y*40+20]=1;f.update();
  const p=planVacuumMapPath(f.data,{x:3150,y:2050},200);
  assert.ok(p.waypoints.some(v=>v.y<800||v.y>3100));
  for(let n=1;n<p.waypoints.length;n++) {
    const a=p.waypoints[n-1]!,b=p.waypoints[n]!;
    for(let i=0;i<=100;i++){const x=a.x+(b.x-a.x)*i/100,y=a.y+(b.y-a.y)*i/100;assert.ok(!(x>=1700&&x<=2400&&y>=500&&y<=3400),"inflated wall intersection");}
  }
});

test("additional hidden/unreachable/object/unknown bits block targets; carpet alone does not",()=>{
  for(const flag of [1,2,8,16,255]) {const f=fixture();f.extra[20*40+31]=flag;f.update();assert.throws(()=>planVacuumMapPath(f.data,{x:3150,y:2050}),/目标位于/);}
  const f=fixture();f.extra[20*40+31]=4;f.update();assert.equal(planVacuumMapPath(f.data,{x:3150,y:2050}).state,"planned");
});

test("virtual walls and hidden polygons are respected and unfamiliar forbidden regions stop planning",()=>{
  const f=fixture();f.data.map.fb_walls=[{wall_points:[2050,0,2050,4000]}];
  assert.throws(()=>planVacuumMapPath(f.data,{x:3150,y:2050}),/没有可通行路径/);
  delete f.data.map.fb_walls;f.data.map.hidden_zones=[{zone_points:[3000,1900,3300,1900,3300,2200,3000,2200]}];
  assert.throws(()=>planVacuumMapPath(f.data,{x:3150,y:2050}),/目标位于/);
  f.data.map.fb_regions=[{unverified:[1,2]}];assert.throws(()=>planVacuumMapPath(f.data,{x:3150,y:2050}),/禁行区域格式尚未核对/);
});

test("planner rejects absent pose, unknown semantics, rotation, outside/blocked endpoints and excessive constraints",()=>{
  const f=fixture(), target={x:3150,y:2050};
  assert.throws(()=>planVacuumMapPath(f.data,target,199),/净空半径/);
  assert.throws(()=>planVacuumMapPath(f.data,{x:Infinity,y:0}),/目标坐标/);
  assert.throws(()=>planVacuumMapPath(f.data,{x:-1,y:0}),/目标位于/);
  f.data.grid.cellSemanticsVerified=false;assert.throws(()=>planVacuumMapPath(f.data,target),/栅格含义/);f.data.grid.cellSemanticsVerified=true;
  f.data.grid.rotation=90;assert.throws(()=>planVacuumMapPath(f.data,target),/旋转/);f.data.grid.rotation=0;
  f.data.robotPosition=undefined;assert.throws(()=>planVacuumMapPath(f.data,target),/没有机器人位置/);f.data.robotPosition={x:50,y:50};assert.throws(()=>planVacuumMapPath(f.data,target),/起点没有足够净空/);
  f.data.map.hidden_zones=Array.from({length:256},()=>({zone_points:Array.from({length:128},(_,i)=>i)}));
  assert.throws(()=>planVacuumMapPath(f.data,target),/计算上限/);
});
