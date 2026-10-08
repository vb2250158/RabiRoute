import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type dgram from "node:dgram";
import { addressBlock, cs2Frame, cs2RelayOffer, cs2SessionAllocation, peerBlock, publicRelayAddress, VacuumCs2Relay } from "./vacuumCs2Relay.js";

test("CS2 cloud init string matches independent published server vector; malformed and private destinations reject", () => {
  const init = "EBGBEPBPKGJKHOJOELGHEKEKHLMFHLNCGKELBICIBJIILILDCABCCGODHBKHJFKGBGNLLHCMPHNOAEDHICMMIEBANPOLBD";
  assert.deepEqual(cs2RelayOffer("ABCDEF-123456-GHIJK", init)?.servers, ["104.166.181.58", "169.197.116.186", "169.197.116.216"]);
  for (const peer of ["bad", "ABCDEFGH-4294967296-I", "ABCDEFGHI-1-I"]) assert.throws(() => peerBlock(peer));
  for (const ip of ["localhost", "127.0.0.1", "10.1.1.1", "192.168.31.88", "172.16.1.1", "169.254.1.1", "100.64.1.1", "224.0.0.1"]) assert.equal(publicRelayAddress(ip), false);
  assert.throws(() => cs2RelayOffer("ABCDEF-123456-GHIJK", "invalid"));
  assert.throws(() => cs2RelayOffer("ABCDEF-123456-GHIJK", "EBGDEOBOKGICGAIAFFGNEAFMGPMHGFNDGNFLBHDKADJGLBKFDOBEDGPEHAKBIJLMBG:camera"));
  assert.equal(peerBlock("ABCDEF-123456-GHIJK").toString("hex"), "41424344454600000001e2404748494a4b000000");
  assert.equal(addressBlock({ address: "203.0.113.7", port: 28723 }).toString("hex"), "00023370077100cb0000000000000000");
});

class SocketFixture extends EventEmitter {
  sent: Array<{ bytes: Buffer; port: number; address: string }> = [];
  closed = false;
  constructor(readonly localPort: number, private readonly respond?: (bytes: Buffer, port: number, address: string) => void) { super(); }
  bind(_port: number, _address: string, done: () => void) { done(); }
  address() { return { port: this.localPort, address: "0.0.0.0", family: "IPv4" }; }
  connect(_port: number, _address: string, done: () => void) { done(); }
  disconnect() {}
  send(bytes: Buffer, port: number, address: string, done: () => void) { this.sent.push({ bytes: Buffer.from(bytes), port, address }); this.respond?.(bytes, port, address); done(); }
  close() { this.closed = true; this.emit("close"); }
  receive(type: number, payload: Buffer, address: string, port: number) { this.emit("message", cs2Frame(type, payload), { address, port }); }
}
function fixture(respond = true, allocation = Buffer.from("010203047531", "hex"), staleFirstRound = false) {
  const server = "198.51.100.1", relayAddress = "203.0.113.2", token = Buffer.from("01020304", "hex");
  let paged = false, discoveries = 0, remote: SocketFixture;
  remote = new SocketFixture(40000, (bytes, _port, address) => {
    if (!respond) return;
    const reply = (type: number, payload: Buffer, from: string, port: number) => queueMicrotask(() => remote.receive(type, payload, from, port));
    if (bytes[1] === 0x67) { discoveries++; reply(0x82, Buffer.concat([addressBlock({ address: relayAddress, port: 25000 }), token]), server, 32100); }
    if (bytes[1] === 0x70 && (!staleFirstRound || discoveries > 1)) reply(0x71, Buffer.alloc(0), relayAddress, 25000);
    if (bytes[1] === 0x72) reply(0x73, allocation, relayAddress, 25000);
    if (bytes[1] === 0x80) paged = true;
    if (bytes[1] === 0x83 && paged && address === relayAddress) reply(0x84, Buffer.alloc(0), relayAddress, allocation.readUInt16BE(4));
  });
  const local = new SocketFixture(40001); let count = 0;
  const client = new VacuumCs2Relay({ peer: "ABCDEF-123456-GHIJK", servers: [server] }, () => (count++ === 0 ? remote : local) as unknown as dgram.Socket);
  return { client, remote, local, relayAddress };
}
test("relay handshake registers tokens and session NAT mapping; bridge preserves MISS bytes and rejects unrelated senders", async () => {
  const f = fixture(), controller = new AbortController();
  try {
    assert.equal(await f.client.connect(controller.signal), "127.0.0.1:40001");
    const types = f.remote.sent.map(item => item.bytes[1]);
    assert.ok(types.indexOf(0x83) < types.indexOf(0x70)); assert.ok(types.includes(0x80));
    f.local.receive(0x30, Buffer.alloc(0), "127.0.0.1", 32111);
    f.local.receive(0x41, peerBlock("ABCDEF-123456-GHIJK"), "127.0.0.1", 32111);
    assert.deepEqual(f.local.sent.slice(-2).map(item => item.bytes[1]), [0x41, 0x42]);
    const bytes = cs2Frame(0xd0, Buffer.from("d100000000010203", "hex"));
    f.local.emit("message", bytes, { address: "127.0.0.1", port: 32111 });
    assert.ok(f.remote.sent.at(-1)!.bytes.equals(bytes));
    f.remote.emit("message", bytes, { address: f.relayAddress, port: 30001 });
    assert.ok(f.local.sent.at(-1)!.bytes.equals(bytes));
    const sentCount = f.local.sent.length, remoteCount = f.remote.sent.length;
    f.remote.emit("message", bytes, { address: "203.0.113.99", port: 30001 });
    f.local.emit("message", bytes, { address: "127.0.0.1", port: 32112 });
    f.remote.emit("message", Buffer.from([0xf1, 0xd0, 0, 99]), { address: f.relayAddress, port: 30001 });
    assert.equal(f.local.sent.length, sentCount); assert.equal(f.remote.sent.length, remoteCount);
    const setup = Buffer.alloc(88); setup.set([0xa1, 1, 0, 0x30]); setup.set([0xaa, 0xbb, 0xcc, 0xdd],4);
    peerBlock("ABCDEF-123456-GHIJK").copy(setup,20); addressBlock({address:"198.51.100.20",port:28926}).copy(setup,40);
    f.remote.receive(0x28,setup,f.relayAddress,30001);
    const answer=f.remote.sent.at(-1)!.bytes;assert.equal(answer[1],0x28);assert.equal(answer[5],2);
    assert.equal(answer.subarray(60,68).toString("hex"),"feffffffddccbbaa");
    assert.equal(answer.subarray(84,92).toString("hex"),"020070fec6336414");
    f.remote.receive(0xf0, Buffer.alloc(0), f.relayAddress, 30001);
    assert.equal(f.local.sent.at(-1)!.bytes[1], 0xf0);
    f.local.receive(0xf1, Buffer.alloc(0), "127.0.0.1", 32111);
    assert.equal(f.remote.sent.at(-1)!.bytes[1], 0xf1);
    controller.abort(); assert.equal(f.remote.closed, true); assert.equal(f.local.closed, true);
    assert.equal(f.remote.sent.at(-1)!.bytes[1], 0xf0);
  } finally { f.client.close(); }
});

test("independent eight-byte port ACK vector preserves the big-endian port and token", async () => {
  // micam/src/test/java/micam/pppp/WireFormatTest.java, readsSessionPortBigEndian.
  const bytes = Buffer.from("5566778874280000", "hex");
  const parsed = cs2SessionAllocation(bytes)!;
  assert.equal(parsed.port, 29736); assert.equal(parsed.token.toString("hex"), "55667788");
  assert.equal(cs2SessionAllocation(bytes.subarray(0, 5)), undefined);
  assert.equal(cs2SessionAllocation(Buffer.from("556677880000", "hex")), undefined);
  assert.equal(cs2SessionAllocation(Buffer.alloc(4093)), undefined);
  const f = fixture(true, bytes);
  try {
    await f.client.connect(new AbortController().signal);
    const join = f.remote.sent.find(item => item.bytes[1] === 0x80)!;
    assert.equal(join.bytes.subarray(-4).toString("hex"), "55667788");
    assert.ok(f.remote.sent.some(item => item.bytes[1] === 0x83 && item.port === 29736));
  } finally { f.client.close(); }
});
test("failed discovery and cancellation close both sockets within their bounded intent", async () => {
  const f = fixture(false); await assert.rejects(f.client.connect(new AbortController().signal, 15), /camera_relay_discovery_timeout/);
  assert.ok(f.remote.closed && f.local.closed);
  const next = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(next.client.connect(controller.signal), /camera_relay_cancelled/); assert.ok(next.remote.closed && next.local.closed);
});
test("registration failure reacquires discovery in the same bounded session instead of replaying one stale token round", async () => {
 const f=fixture(true,Buffer.from("010203047531","hex"),true);
 try{assert.equal(await f.client.connect(new AbortController().signal),"127.0.0.1:40001");assert.ok(f.remote.sent.filter(p=>p.bytes[1]===0x67).length>=2);}
 finally{f.client.close();}
});
test("LAN bridge verifies the cloud UID, completes UDP handover and preserves media from only its learned peer",async()=>{
 const uid=peerBlock("ABCDEF-123456-GHIJK");let remote:SocketFixture;
 remote=new SocketFixture(40000,(bytes,_port,address)=>{const type=bytes[1]===0x30?0x41:bytes[1]===0x41?0x42:undefined;if(type)queueMicrotask(()=>remote.receive(type,uid,address,32001));});
 const local=new SocketFixture(40001);let count=0;
 const client=new VacuumCs2Relay({peer:"ABCDEF-123456-GHIJK",servers:["198.51.100.1"]},()=>((count++===0?remote:local) as unknown as dgram.Socket));
 try{assert.equal(await client.connectLocal("192.168.1.20",new AbortController().signal),"127.0.0.1:40001");assert.ok(!remote.sent.some(p=>p.bytes[1]===0x67));local.receive(0x30,Buffer.alloc(0),"127.0.0.1",32111);const media=cs2Frame(0xd0,Buffer.from([1,2,3]));remote.emit("message",media,{address:"192.168.1.20",port:32001});assert.ok(local.sent.at(-1)!.bytes.equals(media));const before=local.sent.length;remote.emit("message",media,{address:"192.168.1.21",port:32001});assert.equal(local.sent.length,before);}finally{client.close();}
 const bad=new VacuumCs2Relay({peer:"ABCDEF-123456-GHIJK",servers:["198.51.100.1"]},()=>new SocketFixture(40002) as unknown as dgram.Socket);await assert.rejects(bad.connectLocal("127.0.0.1",new AbortController().signal),/parameters_invalid/);bad.close();
});
