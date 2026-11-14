import net from "node:net";
import { once } from "node:events";
import type { NapcatPortInspection } from "../../manager/napcatLifecycleOwner.js";
import { NapcatState } from "@rabiroute/host-api/shared/napcatStateContract";

/** External launchers cannot inherit our socket. Candidate probes are bounded and never prove readiness. */
export async function napcatExternalPortCandidate(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const probe = net.createServer(); probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const address = probe.address();
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    if (!address || typeof address === "string") throw new Error("No local NapCat port candidate.");
    if (!excluded.has(address.port)) { excluded.add(address.port); return address.port; }
  }
  throw new Error("Could not select a distinct NapCat port candidate.");
}

export async function recoverNapcatExternalPorts<T extends { httpUrl: string; webuiUrl?: string }>(options: {
  instance: T;
  assertCurrent(): void;
  stopped(): Promise<NapcatPortInspection | undefined>;
  writeCandidate(instance: T): Promise<void> | void;
  launch(instance: T): Promise<Record<string, unknown>>;
  verify(instance: T): Promise<{ httpReady: boolean } | undefined>;
  conflicted(instance: T): Promise<boolean>;
  stopOwned(): Promise<void>;
  publish(instance: T): void;
}): Promise<Record<string, unknown> | undefined> {
  options.assertCurrent();
  const initial = await options.stopped();
  options.assertCurrent();
  if (!initial?.instanceStopped || !initial.listeners.length) return;
  const excluded = new Set([options.instance.httpUrl, options.instance.webuiUrl].filter(Boolean).map(value => Number(new URL(value!).port)));
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Re-prove original process absence before each file mutation, including retries after a raced bind.
    const stopped = await options.stopped();
    options.assertCurrent();
    if (!stopped?.instanceStopped) throw new Error("NapCat original process exit is unconfirmed; port recovery stopped.");
    const http = new URL(options.instance.httpUrl), webui = new URL(options.instance.webuiUrl!);
    http.port = String(await napcatExternalPortCandidate(excluded)); webui.port = String(await napcatExternalPortCandidate(excluded));
    const candidate = { ...options.instance, httpUrl: http.href.replace(/\/$/, ""), webuiUrl: webui.href };
    options.assertCurrent(); await options.writeCandidate(candidate);
    let result: Record<string, unknown>;
    try { result = await options.launch(candidate); }
    catch (error) {
      if (!await options.conflicted(candidate)) throw error;
      options.assertCurrent();
      // Retry only a classified foreign bind conflict, never an arbitrary launch failure.
      await options.stopOwned();
      if (attempt === 3) throw error;
      continue;
    }
    options.assertCurrent();
    const verified = await options.verify(candidate);
    options.assertCurrent();
    if (verified) {
      options.publish(candidate);
      return { ...result, ok: verified.httpReady, state: verified.httpReady ? NapcatState.Ready : NapcatState.OnebotNotReady,
        needsUserAction: !verified.httpReady, externalPortRecovery: { attempts: attempt, verified: true,
        httpListenerReady: verified.httpReady, httpUrl: candidate.httpUrl, webuiUrl: candidate.webuiUrl } };
    }
    if (!await options.conflicted(candidate)) throw new Error("NapCat listener identity or authorization is unconfirmed; preserved original process ownership.");
    options.assertCurrent();
    await options.stopOwned();
  }
  throw new Error("NapCat external ports did not acquire a verified owned listener after three attempts.");
}
