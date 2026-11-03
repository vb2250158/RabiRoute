import path from "node:path";
import { SpeechIngressStore } from "../speechIngressStore.js";
import { ManagerSpeechControl, SpeechControlError, type ManagerSpeechControlDependencies } from "./speechControl.js";
import { SpeechRuntimeControl } from "./speechRuntimeControl.js";
import { SpeechModelManager } from "./speechModelManager.js";
import { SelectionSpeechSettingsStore, selectionSpeechSettingsPath } from "./selectionSpeechSettings.js";
import { SpeechApiOwner, createSpeechApiOperations } from "./speechApiOperations.js";
import type { SpeechApiContext } from "./speechApiContext.js";
import type { SpeechModelManagementSnapshot } from "../shared/speechModelManagement.js";
import { createPluginServicePort } from "../runtime/pluginServicePort.js";
import { createPeerSpeechAdapter } from "../peerTunnel/speechAdapter.js";
import type { PeerTunnelRuntime } from "../peerTunnel/runtime.js";

export type SpeechPluginPorts = Readonly<{
  rootDir: string;
  packageRoot: string;
  control: Omit<ManagerSpeechControlDependencies, "speechIngressStore" | "localSpeech">;
  api: Omit<SpeechApiContext, "speechControl" | "speechRuntimeControl" | "speechModelManager" | "selectionSpeechSettings" | "speechIngressStore">;
  currentService(capability: string): unknown;
  modelChanged(snapshot: SpeechModelManagementSnapshot): void;
  reportError(reason: string, error: unknown): void;
  peerRuntime(): Pick<PeerTunnelRuntime, "selected" | "fetch"> | undefined;
  computeTarget(): string | undefined;
}>;

/** The service package owns every speech business instance; the host supplies only ports. */
function createSpeechResources(ports: SpeechPluginPorts) {
  const speechIngressStore = new SpeechIngressStore(path.join(ports.rootDir, "data", "speech", "messages"), path.join(ports.rootDir, "data", "speech", "deliveries"));
  const selectionSpeechSettings = new SelectionSpeechSettingsStore(selectionSpeechSettingsPath(ports.rootDir));
  const speechModelManager = new SpeechModelManager({ rootDir: ports.rootDir, packageRoot: ports.packageRoot, onChange: ports.modelChanged });
  const speechRuntimeControl = new SpeechRuntimeControl({ rootDir: ports.rootDir, packageRoot: ports.packageRoot,
    serviceUrl: ports.control.serviceUrl, ensureDependencies: allowFirstInstall => speechModelManager.ensureRuntime(allowFirstInstall) });
  const subscribed = (route: ReturnType<ManagerSpeechControlDependencies["route"]>) => route && ({
    ...route, speechEnabled: route.speechEnabled && Boolean(ports.currentService("endpoint.speech@1")),
    rabiLinkEnabled: route.rabiLinkEnabled === true && Boolean(ports.currentService("endpoint.rabilink@1"))
  });
  const speechControl = new ManagerSpeechControl({ ...ports.control, speechIngressStore, localSpeech: createPeerSpeechAdapter(ports.peerRuntime, ports.computeTarget),
    route: id => subscribed(ports.control.route(id)), routes: () => ports.control.routes().map(route => subscribed(route)!) });
  return { speechControl, speechRuntimeControl, speechModelManager, speechIngressStore, selectionSpeechSettings,
    drains: new Set<Promise<void>>(), operations: new Set<Promise<unknown>>(), shutdown: undefined as Promise<void> | undefined };
}

export type SpeechPluginResources = ReturnType<typeof createSpeechResources>;
export function createSpeechPluginRuntime(ports: SpeechPluginPorts, previous?: { resources: SpeechPluginResources }, instanceId = "") {
  const resources = previous?.resources ?? createSpeechResources(ports);
  let ready = false;
  const available = <T extends object>(owner: T) => createPluginServicePort(() => {
    if (!ready || !service.isCurrent()) throw new SpeechControlError("Speech service is unavailable or waiting for its previous activation to retire.", 409);
    return owner;
  });
  const speechControl = available(resources.speechControl), speechRuntimeControl = available(resources.speechRuntimeControl);
  const speechModelManager = available(resources.speechModelManager), speechIngressStore = available(resources.speechIngressStore);
  const selectionSpeechSettings = available(resources.selectionSpeechSettings);
  const speechApiContext: SpeechApiContext = Object.freeze({ ...ports.api,
    speechControl, speechRuntimeControl, speechModelManager, speechIngressStore, selectionSpeechSettings });
  const service = Object.freeze({ instanceId, resources, speechControl, speechRuntimeControl, speechModelManager, speechIngressStore, selectionSpeechSettings,
    SpeechApiOwner, createSpeechApiOperations, speechApiContext,
    isCurrent: () => ports.currentService("manager.speech@1") === service,
    replacementOwnsResources: () => {
      const current = ports.currentService("manager.speech@1") as { resources?: unknown } | undefined;
      return current !== service && current?.resources === resources;
    },
    markReady: () => { ready = true; },
    runAcceptedWork<T>(operation: () => Promise<T>): Promise<T> {
      service.assertCurrent();
      const pending = Promise.resolve().then(operation);
      resources.operations.add(pending);
      void pending.then(() => resources.operations.delete(pending), () => resources.operations.delete(pending));
      return pending;
    },
    reconcile(reason = "manager startup") {
      if (!service.isCurrent() || !ready) return;
      void resources.speechRuntimeControl.start(undefined, false)
        .then(() => service.isCurrent() && ready ? resources.speechControl.reconcileMicrophone(service.assertCurrent) : undefined)
        .catch(error => { if (service.isCurrent() && ready) ports.reportError(reason, error); });
    },
    assertCurrent() { if (!ready || !service.isCurrent()) throw new SpeechControlError("Speech activation is no longer current.", 409); },
    stopResources() {
      ready = false;
      return resources.shutdown ??= (async () => {
        const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([...resources.drains]);
        // Business failures belong to their original callers. Joining completed
        // ASR/TTS work does not turn its failure into an unconfirmed shutdown.
        await Promise.allSettled([...resources.operations]);
        results.push(...await Promise.allSettled([
          Promise.resolve().then(() => resources.speechRuntimeControl.releaseOwnedRuntime()),
          Promise.resolve().then(() => resources.speechModelManager.stop())
        ]));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
    }
  });
  return service;
}
