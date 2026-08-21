import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type http from "node:http";
import { createDesktopControlRoutes, type DesktopControlRoutesContext } from "./desktopControlRoutes.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function request(method = "POST"): http.IncomingMessage {
  const value = new EventEmitter() as http.IncomingMessage;
  Object.defineProperties(value, {
    method: { value: method, writable: true },
    socket: { value: { remoteAddress: "127.0.0.1" } }
  });
  return value;
}

function response(): http.ServerResponse {
  const value = new EventEmitter() as http.ServerResponse;
  Object.defineProperties(value, {
    destroyed: { value: false, writable: true },
    writableEnded: { value: false, writable: true }
  });
  value.setHeader = (() => value) as http.ServerResponse["setHeader"];
  value.end = ((..._args: unknown[]) => {
    Object.defineProperty(value, "writableEnded", { value: true, writable: true });
    value.emit("finish");
    return value;
  }) as http.ServerResponse["end"];
  value.destroy = (() => {
    Object.defineProperty(value, "destroyed", { value: true, writable: true });
    value.emit("close");
    return value;
  }) as http.ServerResponse["destroy"];
  return value;
}

function createContext(rootDir: string, shutdownManager: DesktopControlRoutesContext["shutdownManager"]): DesktopControlRoutesContext {
  return {
    openConfigFilePayload: () => ({ code: 0 }),
    rootDir,
    shutdownManager,
    jsonResponse: (target, statusCode, body) => {
      target.statusCode = statusCode;
      target.end(JSON.stringify(body));
    }
  };
}

function finishJsonRequest(target: http.IncomingMessage, body: Record<string, unknown> = {}): void {
  target.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
  target.emit("end");
}

test("desktop control drain waits for the complete request body chain and rejects late shutdown timers", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-control-"));
  const shutdownReasons: string[] = [];
  try {
    const routes = createDesktopControlRoutes(createContext(rootDir, reason => {
      shutdownReasons.push(reason);
    }));
    const incoming = request();
    const outgoing = response();

    assert.equal(routes.handler(
      incoming,
      new URL("http://127.0.0.1/manager/shutdown"),
      outgoing
    ), true);
    outgoing.emit("close");

    let drained = false;
    const stopping = routes.stopAcceptingAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);

    finishJsonRequest(incoming);
    await stopping;
    assert.deepEqual(shutdownReasons, []);
    assert.equal(routes.handler(
      request(),
      new URL("http://127.0.0.1/manager/shutdown"),
      response()
    ), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("desktop control drain cancels shutdown timers that have not fired", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-control-"));
  const shutdownReasons: string[] = [];
  try {
    const routes = createDesktopControlRoutes(createContext(rootDir, reason => {
      shutdownReasons.push(reason);
    }));
    const incoming = request();

    assert.equal(routes.handler(
      incoming,
      new URL("http://127.0.0.1/manager/shutdown"),
      response()
    ), true);
    finishJsonRequest(incoming);
    await Promise.resolve();

    await routes.stopAcceptingAndDrain();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(shutdownReasons, []);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("desktop control drain waits for a shutdown operation whose timer already fired", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-control-"));
  const shutdownStarted = deferred();
  const releaseShutdown = deferred();
  try {
    const routes = createDesktopControlRoutes(createContext(rootDir, async () => {
      shutdownStarted.resolve();
      await releaseShutdown.promise;
    }));
    const incoming = request();

    assert.equal(routes.handler(
      incoming,
      new URL("http://127.0.0.1/manager/shutdown"),
      response()
    ), true);
    finishJsonRequest(incoming);
    await shutdownStarted.promise;

    let drained = false;
    const stopping = routes.stopAcceptingAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);

    releaseShutdown.resolve();
    await stopping;
    assert.equal(drained, true);
  } finally {
    releaseShutdown.resolve();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
