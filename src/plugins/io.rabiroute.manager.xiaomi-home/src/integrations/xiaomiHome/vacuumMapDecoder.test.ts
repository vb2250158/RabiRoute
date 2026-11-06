import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { decodeXiaomiVacuumMap } from "./vacuumMapDecoder.js";

const model = "xiaomi.vacuum.demo1", deviceId = "123456789";
function encode(map: unknown, id = deviceId, mapModel = model): Buffer {
  const iv = Buffer.from("ABCDEF1234123412"), modelKey = Buffer.from(mapModel.slice(-16));
  const derive = createCipheriv("aes-128-cbc", modelKey, iv);
  const material = Buffer.concat([derive.update(Buffer.concat([modelKey, Buffer.from(id)])), derive.final()]);
  const cipher = createCipheriv("aes-128-cbc", createHash("md5").update(material).digest(), iv);
  const data = Buffer.concat([cipher.update(deflateSync(Buffer.from(JSON.stringify(map)))), cipher.final()]).toString("base64");
  return Buffer.from(JSON.stringify({ version: 2, data }));
}
function map() {
  return { map_id: 1, width: 2, height: 2, origin_x: -100, origin_y: -100, resolution: 50, rotate: 0,
    map_data: deflateSync(Buffer.from([0, 1, 3, 255])).toString("base64"), have_pile: true, pile_x: -75, pile_y: -75, pile_yaw: 0,
    position: { x: -25, y: -25, yaw: 1000 }, room_attrs: [{ id: 3, room_name: "Demo room", name_pos_x: -50, name_pos_y: -50 }] };
}

test("decode version2 geometry, exact grid and native poses without declaring navigation or freshness", () => {
  const decoded = decodeXiaomiVacuumMap(encode(map()), model, deviceId);
  assert.equal(decoded.decoded, true); assert.equal(decoded.grid.width, 2); assert.equal(decoded.grid.unit, "millimeters");
  assert.deepEqual(Buffer.from(decoded.grid.dataBase64, "base64"), Buffer.from([0, 1, 3, 255]));
  assert.equal(decoded.grid.originY, -100); assert.equal(decoded.robotPosition?.x, -25); assert.equal(decoded.rooms[0]?.name, "Demo room");
  assert.equal(decoded.poseFreshness, "unverified"); assert.equal(decoded.coordinateNavigation, false);
});

test("decoder fails closed on wrong device key, malformed envelopes and non-map payloads", () => {
  assert.throws(() => decodeXiaomiVacuumMap(encode(map()), model, "987654321"));
  for (const input of [Buffer.from('{"version":1}'), Buffer.from('{"version":2,"data":"??"}'), encode([]), encode({})]) assert.throws(() => decodeXiaomiVacuumMap(input, model, deviceId));
});

test("decoder rejects grid mismatch, geometry coercion and decompression/size expansion", () => {
  for (const candidate of [{ ...map(), width: 3 }, { ...map(), resolution: "50" }, { ...map(), width: 4096, height: 4096 }, { ...map(), map_data: deflateSync(Buffer.alloc(4194305)).toString("base64") }]) {
    assert.throws(() => decodeXiaomiVacuumMap(encode(candidate), model, deviceId));
  }
});


test("pv11cn has verified wall, high-room and additional-grid semantics; other models stay unverified", () => {
  const candidate = { ...map(), additional_map_data: deflateSync(Buffer.from([0,1,2,8])).toString("base64") };
  const decoded = decodeXiaomiVacuumMap(encode(candidate,deviceId,"xiaomi.vacuum.pv11cn"),"xiaomi.vacuum.pv11cn",deviceId);
  assert.equal(decoded.grid.cellSemanticsVerified,true);
  assert.deepEqual(decoded.grid.labels?.wall,[1]); assert.deepEqual(decoded.grid.labels?.floor,[2]);
  assert.deepEqual(decoded.grid.labels?.roomGridRange,[3,255]);
  assert.deepEqual(Buffer.from(decoded.grid.additionalDataBase64!,"base64"),Buffer.from([0,1,2,8]));
  assert.equal(decodeXiaomiVacuumMap(encode(map()),model,deviceId).grid.cellSemanticsVerified,false);
  assert.throws(()=>decodeXiaomiVacuumMap(encode({...map(),additional_map_data:deflateSync(Buffer.from([0])).toString("base64")}),model,deviceId),/Additional map grid/);
});
