import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { CodexDesktopDeliveryEvent } from "../codexDesktopBridge.js";

type ReceiptListener = (event: Partial<CodexDesktopDeliveryEvent>) => void;

/** Exercise the actual native owner's subscription lifecycle without starting Manager or Desktop IPC. */
function actualNativeReceiptLifecycle(recover: () => void) {
  const source = ts.createSourceFile("codexManagerProvider.ts", fs.readFileSync(new URL("../agentAdapters/codexManagerProvider.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const factory = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "createManager");
  const result = factory?.body?.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(result && ts.isObjectLiteralExpression(result), "The native owner must expose its existing lifecycle.");
  const method = (name: string) => result.properties.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  const start = method("start"), unpublish = method("unpublish");
  assert.ok(start?.body && unpublish?.body, "The native owner must own registration and unregistration.");
  const compiled = ts.transpileModule(`let unsubscribe: (() => void) | undefined; const lifecycle = {${start.getText(source)},${unpublish.getText(source)}};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  const listeners = new Set<ReceiptListener>();
  let subscriptions = 0, releases = 0;
  const lifecycle = new Function("subscribeCodexDesktopDelivery", "options", compiled + "\nreturn lifecycle;")(
    (listener: ReceiptListener) => { subscriptions++; listeners.add(listener); return () => { releases++; listeners.delete(listener); }; },
    { host: { deliveryReceiptChanged: recover } }
  ) as { start(): void; unpublish(): void };
  return { ...lifecycle, emit: (event: Partial<CodexDesktopDeliveryEvent>) => { for (const listener of [...listeners]) listener(event); },
    subscriptions: () => subscriptions, releases: () => releases, listeners: () => listeners.size };
}

for (const method of ["thread-follower-start-turn", "thread-follower-steer-turn"] as const) {
  test(`the actual native Manager listener wakes original receipt recovery for late ${method}`, () => {
    let recoveries = 0;
    const owner = actualNativeReceiptLifecycle(() => { recoveries++; });
    owner.start(); owner.start();
    try {
      assert.equal(owner.subscriptions(), 1); assert.equal(owner.listeners(), 1);
      owner.emit({ stage: "delivery_unconfirmed", late: true, method, outcome: "unconfirmed" });
      owner.emit({ stage: "delivery_receipt_missing", late: true, method, outcome: "unconfirmed" });
      owner.emit({ stage: "delivery_receipt_confirmed", method, outcome: "confirmed" });
      assert.equal(recoveries, 0, "Missing or ordinary evidence cannot create an extra recovery wake.");
      owner.emit({ stage: "delivery_receipt_confirmed", late: true, method, outcome: "confirmed", deliveryMarker: "original-delivery", threadId: "original-thread" });
      assert.equal(recoveries, 1, "Both native methods enter the existing original-ID receipt-only recovery.");
      owner.unpublish();
      assert.equal(owner.releases(), 1); assert.equal(owner.listeners(), 0);
      owner.emit({ stage: "delivery_receipt_confirmed", late: true, method, outcome: "confirmed", deliveryMarker: "original-delivery", threadId: "original-thread" });
      assert.equal(recoveries, 1, "Unpublished native owners cannot keep waking the Manager.");
    } finally { owner.unpublish(); }
  });
}
