import { configureTimeouts, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import type http from "node:http";
import test from "node:test";
import {
  handleManagerLanDiscoveryRequest,
  MANAGER_DISCOVERY_PATH,
  MANAGER_DISCOVERY_PROTOCOL_VERSION,
  MANAGER_DISCOVERY_SERVICE_TYPE
} from "./managerLanDiscovery.js";
import {
  startManagerDiscoveryPublisher,
  type BonjourFactory,
  type ManagerDiscoveryStatus
} from "./managerLanDiscoveryPublisher.js";

test("Manager LAN discovery uses a versioned DNS-SD contract without a fixed port", () => {
  assert.equal(MANAGER_DISCOVERY_SERVICE_TYPE, "rabiroute");
  assert.equal(MANAGER_DISCOVERY_PROTOCOL_VERSION, 1);
  assert.equal(MANAGER_DISCOVERY_PATH, "/.well-known/rabiroute-manager");
});

test("Manager LAN discovery document is public only on the exact enabled well-known path", () => {
  const calls: Array<{ statusCode: number; body: unknown }> = [];
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); }
  } as unknown as http.ServerResponse;
  const request = { method: "GET" } as http.IncomingMessage;
  const document = Object.freeze({
    protocolVersion: 1 as const,
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a",
    guid: "rabi-a",
    name: "Rabi",
    computerName: "pc-a",
    deviceType: "RabiRoute Manager" as const,
    version: "1.0.0"
  });
  const handled = handleManagerLanDiscoveryRequest(
    request,
    new URL(`http://192.0.2.1${MANAGER_DISCOVERY_PATH}`),
    response,
    {
      enabled: true,
      document: () => document,
      jsonResponse: (_response, statusCode, body) => { calls.push({ statusCode, body }); }
    }
  );
  assert.equal(handled, true);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([{ statusCode: 200, body: { code: 0, data: { ...document, timeoutOverrides: readTimeoutOverrides() } } }])
  );

  calls.length = 0;
  handleManagerLanDiscoveryRequest(
    request,
    new URL(`http://192.0.2.1${MANAGER_DISCOVERY_PATH}`),
    response,
    {
      enabled: false,
      document: () => { throw new Error("disabled discovery must not evaluate identity"); },
      jsonResponse: (_response, statusCode, body) => { calls.push({ statusCode, body }); }
    }
  );
  assert.equal(calls[0]?.statusCode, 404);
});

test("Manager DNS-SD publisher advertises the actual listener port and destroys its socket", async () => {
  const events = new EventEmitter();
  let published: Record<string, unknown> | undefined;
  let stopped = false;
  let destroyed = false;
  const factory: BonjourFactory = () => ({
    publish(options) {
      published = options as unknown as Record<string, unknown>;
      queueMicrotask(() => events.emit("up"));
      return Object.assign(events, {
        stop(callback?: () => void) { stopped = true; callback?.(); }
      });
    },
    destroy() { destroyed = true; }
  });
  const statuses: ManagerDiscoveryStatus[] = [];
  const publisher = await startManagerDiscoveryPublisher({
    port: 54321,
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a",
    guid: "guid-a",
    onStatus: status => statuses.push(status)
  }, factory);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published?.port, 54321);
  assert.equal(published?.type, "rabiroute");
  assert.deepEqual(published?.txt, {
    protocol: "1",
    path: MANAGER_DISCOVERY_PATH,
    applicationGenerationId: "generation-a",
    managerInstanceId: "manager-a",
    guid: "guid-a"
  });
  assert.equal(statuses.at(-1)?.state, "published");
  await publisher.stop();
  assert.equal(stopped, true);
  assert.equal(destroyed, true);
});

test("well-known discovery publishes only the current numeric timeout snapshot", () => {
  const previous = readTimeoutOverrides();
  const previousSecret = process.env.RABIROUTE_DISCOVERY_TEST_SECRET;
  process.env.RABIROUTE_DISCOVERY_TEST_SECRET = "discovery-test-secret";
  try {
    configureTimeouts({ "android.http.connect": 1234, "android.http.read": 5678 });
    let body: unknown;
    handleManagerLanDiscoveryRequest({ method: "GET" } as http.IncomingMessage,
      new URL(`http://192.0.2.1${MANAGER_DISCOVERY_PATH}`),
      { setHeader() {} } as unknown as http.ServerResponse,
      { enabled: true, document: () => ({ protocolVersion: 1, applicationGenerationId: "generation-a",
        managerInstanceId: "manager-a", guid: "guid-a", name: "Rabi", computerName: "pc-a",
        deviceType: "RabiRoute Manager", version: "1.0.0" }),
        jsonResponse: (_response, _status, value) => { body = value; } });
    const data = (body as { data: Record<string, unknown> }).data;
    assert.deepEqual(data.timeoutOverrides, { "android.http.connect": 1234, "android.http.read": 5678 });
    assert.deepEqual(Object.keys(data).sort(), ["protocolVersion", "applicationGenerationId", "managerInstanceId",
      "guid", "name", "computerName", "deviceType", "version", "timeoutOverrides"].sort());
    assert.equal(JSON.stringify(body).includes("discovery-test-secret"), false);
  } finally {
    configureTimeouts(previous);
    if (previousSecret === undefined) delete process.env.RABIROUTE_DISCOVERY_TEST_SECRET;
    else process.env.RABIROUTE_DISCOVERY_TEST_SECRET = previousSecret;
  }
});

const publisherIdentity = {
  port: 54321,
  applicationGenerationId: "generation-a",
  managerInstanceId: "manager-a",
  guid: "guid-a"
};

const interfaceFixture = () => ({
  ethernet: [{ address: "192.0.2.10", family: "IPv4", internal: false }],
  overlay: [{ address: "198.51.100.10", family: "IPv4", internal: false }],
  duplicate: [{ address: "192.0.2.10", family: "IPv4", internal: false }],
  loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  ipv6: [{ address: "2001:db8::1", family: "IPv6", internal: false }]
});

function publicationFixture() {
  const sockets: Array<{
    options: unknown;
    publication?: unknown;
    events: EventEmitter;
    fail: (error: Error) => void;
    stops: number;
    destroys: number;
  }> = [];
  const factory: BonjourFactory = (onError, options) => {
    const socket = {
      options,
      publication: undefined as unknown,
      events: new EventEmitter(),
      fail: onError,
      stops: 0,
      destroys: 0
    };
    sockets.push(socket);
    return {
      publish(publication) {
        socket.publication = publication;
        return Object.assign(socket.events, {
          stop(callback?: () => void) { socket.stops++; callback?.(); }
        });
      },
      destroy() { socket.destroys++; }
    };
  };
  return { sockets, factory };
}

test("Manager DNS-SD publishes on each external IPv4 interface without probing its own identity", async () => {
  const fixture = publicationFixture();
  const publisher = await startManagerDiscoveryPublisher(publisherIdentity, {
    factory: fixture.factory,
    interfaces: interfaceFixture
  });
  try {
    assert.deepEqual(fixture.sockets.map(socket => socket.options), [
      { interface: "192.0.2.10", bind: "0.0.0.0" },
      { interface: "198.51.100.10", bind: "0.0.0.0" }
    ]);
    assert.equal(publisher.status().state, "starting");
    for (const socket of fixture.sockets) socket.events.emit("up");
    assert.equal(publisher.status().state, "published");
    assert.deepEqual(publisher.status().interfaces, [
      { name: "ethernet", address: "192.0.2.10", state: "published" },
      { name: "overlay", address: "198.51.100.10", state: "published" }
    ]);
    const publications = fixture.sockets.map(socket => socket.publication) as Array<Record<string, unknown>>;
    assert.deepEqual(publications[0], publications[1]);
    assert.equal(publications[0]?.probe, false);
    assert.deepEqual(publications[0]?.txt, {
      protocol: "1",
      path: MANAGER_DISCOVERY_PATH,
      applicationGenerationId: "generation-a",
      managerInstanceId: "manager-a",
      guid: "guid-a"
    });
    assert.ok(Object.isFrozen(publisher.status().interfaces));
    assert.ok(Object.isFrozen(publisher.status().interfaces?.[0]));
  } finally {
    await publisher.stop();
  }
  assert.ok(fixture.sockets.every(socket => socket.stops === 1 && socket.destroys === 1));
});

test("Manager DNS-SD reports partial failure and cannot hide total failure with a late up", async () => {
  const fixture = publicationFixture();
  const publisher = await startManagerDiscoveryPublisher(publisherIdentity, {
    factory: fixture.factory,
    interfaces: interfaceFixture
  });
  try {
    fixture.sockets[0]!.fail(new Error("membership failed"));
    fixture.sockets[1]!.events.emit("up");
    assert.equal(publisher.status().state, "published");
    assert.match(publisher.status().message!, /membership failed/);
    assert.equal(publisher.status().interfaces?.[0]?.state, "failed");
    fixture.sockets[1]!.events.emit("error", new Error("send failed"));
    fixture.sockets[0]!.events.emit("up");
    fixture.sockets[1]!.events.emit("up");
    assert.equal(publisher.status().state, "failed");
    assert.ok(publisher.status().interfaces?.every(iface => iface.state === "failed"));
    assert.match(publisher.status().message!, /membership failed/);
    assert.match(publisher.status().message!, /send failed/);
  } finally {
    await Promise.all([publisher.stop(), publisher.stop()]);
  }
  assert.ok(fixture.sockets.every(socket => socket.stops === 1 && socket.destroys === 1));
  fixture.sockets[0]!.fail(new Error("late error"));
  fixture.sockets[1]!.events.emit("up");
  assert.equal(publisher.status().state, "stopped");
});

test("Manager DNS-SD continues after construction and publish failures and cleans every created instance", async () => {
  const destroyed: string[] = [];
  const events = new EventEmitter();
  const factory: BonjourFactory = (_onError, options) => {
    if (options?.interface === "192.0.2.10") throw new Error("constructor failed");
    return {
      publish() {
        if (options?.interface === "198.51.100.10") throw new Error("publish failed");
        return Object.assign(events, { stop(callback?: () => void) { callback?.(); } });
      },
      destroy() { destroyed.push(options!.interface!); }
    };
  };
  const publisher = await startManagerDiscoveryPublisher(publisherIdentity, {
    factory,
    interfaces: () => ({
      ...interfaceFixture(),
      wifi: [{ address: "203.0.113.10", family: "IPv4", internal: false }]
    })
  });
  try {
    events.emit("up");
    assert.equal(publisher.status().state, "published");
    assert.equal(publisher.status().interfaces?.filter(iface => iface.state === "failed").length, 2);
  } finally {
    await publisher.stop();
  }
  assert.deepEqual(destroyed.sort(), ["198.51.100.10", "203.0.113.10"]);
});

test("Manager DNS-SD fails explicitly when every factory fails or no eligible interfaces exist", async () => {
  let calls = 0;
  const factory: BonjourFactory = () => { calls++; throw new Error("bind failed"); };
  const failed = await startManagerDiscoveryPublisher(publisherIdentity, { factory, interfaces: interfaceFixture });
  assert.equal(calls, 2);
  assert.equal(failed.status().state, "failed");
  assert.ok(failed.status().interfaces?.every(iface => iface.state === "failed"));
  await failed.stop();
  const empty = await startManagerDiscoveryPublisher(publisherIdentity, { factory, interfaces: () => ({}) });
  assert.equal(calls, 2);
  assert.equal(empty.status().state, "failed");
  assert.deepEqual(empty.status().interfaces, []);
  assert.match(empty.status().message!, /IPv4/);
  await empty.stop();
});

test("Manager DNS-SD stopping releases all sockets even when a service stop throws", async () => {
  const stops: string[] = [];
  const destroys: string[] = [];
  const publisher = await startManagerDiscoveryPublisher(publisherIdentity, {
    interfaces: interfaceFixture,
    factory: (_onError, options) => ({
      publish() {
        return Object.assign(new EventEmitter(), {
          stop(callback?: () => void) {
            stops.push(options!.interface!);
            if (options?.interface === "192.0.2.10") throw new Error("stop failed");
            callback?.();
          }
        });
      },
      destroy() { destroys.push(options!.interface!); }
    })
  });
  await Promise.all([publisher.stop(), publisher.stop()]);
  assert.deepEqual(stops.sort(), ["192.0.2.10", "198.51.100.10"]);
  assert.deepEqual(destroys.sort(), stops);
  assert.equal(publisher.status().state, "stopped");
});

test("Manager DNS-SD default factory selects every egress interface and observes UDP send failure without opening sockets", async t => {
  const sockets: Array<{
    membership?: string;
    egress?: string;
    bindAddress?: string;
    sends: number;
    closed: boolean;
  }> = [];
  t.mock.method(dgram, "createSocket", () => {
    const socket = { sends: 0, closed: false } as typeof sockets[number];
    const events = new EventEmitter();
    sockets.push(socket);
    return Object.assign(events, {
      bind(_port: number, address: string, callback: () => void) {
        socket.bindAddress = address;
        queueMicrotask(() => { events.emit("listening"); callback(); });
      },
      addMembership(_group: string, address: string) { socket.membership = address; },
      setMulticastInterface(address: string) { socket.egress = address; },
      setMulticastTTL() {},
      setMulticastLoopback() {},
      dropMembership() {},
      send(...args: unknown[]) {
        socket.sends++;
        const callback = args.at(-1) as (error?: Error) => void;
        queueMicrotask(() => callback(socket.egress === "198.51.100.10" ? new Error("UDP send failed") : undefined));
      },
      close(callback: () => void) { queueMicrotask(() => { socket.closed = true; callback(); }); }
    });
  });
  const publisher = await startManagerDiscoveryPublisher(publisherIdentity, { interfaces: interfaceFixture });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sockets.map(socket => ({
      membership: socket.membership,
      egress: socket.egress,
      bindAddress: socket.bindAddress
    })), [
      { membership: "192.0.2.10", egress: "192.0.2.10", bindAddress: "0.0.0.0" },
      { membership: "198.51.100.10", egress: "198.51.100.10", bindAddress: "0.0.0.0" }
    ]);
    assert.ok(sockets.every(socket => socket.sends > 0));
    assert.equal(publisher.status().state, "published");
    assert.equal(publisher.status().interfaces?.[1]?.state, "failed");
    assert.match(publisher.status().message!, /UDP send failed/);
  } finally {
    await publisher.stop();
  }
  assert.ok(sockets.every(socket => socket.closed));
});

for (const failure of ["bind", "membership", "interface", "send"] as const) {
  test(`Manager DNS-SD default factory exposes total ${failure} failure instead of false publication`, async t => {
    const sockets: Array<{ closed: boolean }> = [];
    t.mock.method(dgram, "createSocket", () => {
      const socket = { closed: false };
      sockets.push(socket);
      const events = new EventEmitter();
      return Object.assign(events, {
        bind(_port: number, _address: string, callback: () => void) {
          queueMicrotask(() => {
            if (failure === "bind") events.emit("error", Object.assign(new Error("bind failed"), { code: "EACCES" }));
            else { events.emit("listening"); callback(); }
          });
        },
        addMembership() { if (failure === "membership") throw new Error("membership failed"); },
        setMulticastInterface() { if (failure === "interface") throw new Error("interface failed"); },
        setMulticastTTL() {},
        setMulticastLoopback() {},
        dropMembership() {},
        send(...args: unknown[]) {
          queueMicrotask(() => (args.at(-1) as (error?: Error) => void)(failure === "send" ? new Error("send failed") : undefined));
        },
        close(callback: () => void) { queueMicrotask(() => { socket.closed = true; callback(); }); }
      });
    });
    const publisher = await startManagerDiscoveryPublisher(publisherIdentity, { interfaces: interfaceFixture });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(publisher.status().state, "failed");
      assert.ok(publisher.status().interfaces?.every(iface => iface.state === "failed"));
      assert.match(publisher.status().message!, new RegExp(`${failure} failed`));
    } finally {
      await publisher.stop();
    }
    assert.equal(sockets.length, 2);
    assert.ok(sockets.every(socket => socket.closed));
  });
}

test("Manager DNS-SD waits for asynchronous destroy and times out a missing service stop callback", async () => {
  const destroyed: string[] = [];
  const publisher = await startManagerDiscoveryPublisher(publisherIdentity, {
    interfaces: interfaceFixture,
    factory: (_onError, options) => ({
      publish() {
        return Object.assign(new EventEmitter(), {
          stop(callback?: () => void) {
            if (options?.interface !== "192.0.2.10") callback?.();
          }
        });
      },
      async destroy() {
        await new Promise(resolve => setImmediate(resolve));
        destroyed.push(options!.interface!);
        if (options?.interface === "192.0.2.10") throw new Error("destroy failed");
      }
    })
  });
  await publisher.stop();
  assert.deepEqual(destroyed.sort(), ["192.0.2.10", "198.51.100.10"]);
  assert.equal(publisher.status().state, "stopped");
});

test("Manager DNS-SD preserves generation identity across interface copies and changes it across generations", async () => {
  const fixture = publicationFixture();
  const first = await startManagerDiscoveryPublisher(publisherIdentity, { factory: fixture.factory, interfaces: interfaceFixture });
  const second = await startManagerDiscoveryPublisher({
    ...publisherIdentity,
    applicationGenerationId: "generation-b",
    managerInstanceId: "manager-b"
  }, { factory: fixture.factory, interfaces: interfaceFixture });
  try {
    const records = fixture.sockets.map(socket => socket.publication) as Array<{ name: string; txt: Record<string, string> }>;
    assert.deepEqual(records[0], records[1]);
    assert.deepEqual(records[2], records[3]);
    assert.notEqual(records[0]!.txt.applicationGenerationId, records[2]!.txt.applicationGenerationId);
    assert.notEqual(records[0]!.txt.managerInstanceId, records[2]!.txt.managerInstanceId);
    assert.notEqual(records[0]!.name, records[2]!.name);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
