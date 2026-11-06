import type { MessageEndpointHostPorts } from '@rabiroute/plugin-sdk';

/** Only shared owners live here. Platform implementations are bundled inside endpoint packages. */
const owners = {
  "adapters/platformNativeOperations": () => import("../adapters/platformNativeOperations.js"),
  "adapters/webhookAdapter": () => import("../adapters/webhookAdapter.js"),
  "speech/localSpeechClient": () => import("../speech/localSpeechClient.js"),
  "manager/napcatSupervisorService": () => import("../manager/napcatSupervisorService.js"),
  "manager/rabiLinkOwnerStore": () => import("../manager/rabiLinkOwnerStore.js"),
  "rabilinkConversationLedger": () => import("../rabilinkConversationLedger.js"),
  "rabilinkConversationReviewer": () => import("../rabilinkConversationReviewer.js"),
  "wearableHealth": () => import("../wearableHealth.js"),
  "wearableHealthAlertDelivery": () => import("../wearableHealthAlertDelivery.js"),
  "shared/systemEventIngress": () => import("../shared/systemEventIngress.js"),
  "shared/qqStickerContract": () => import("../shared/qqStickerContract.js"),
  "manager/apiOperationContract": () => import("../manager/apiOperationContract.js"),
  "manager/lanAgentBodyAuthority": () => import("../manager/lanAgentBodyAuthority.js"),
  "shared/qqMessageParts": () => import("../shared/qqMessageParts.js"),
  "shared/qqReadSettings": () => import("../shared/qqReadSettings.js"),
  "shared/readSettingsError": () => import("../shared/readSettingsError.js"),
  "shared/napcatDeliveryError": () => import("../shared/napcatDeliveryError.js"),
  "shared/localModelDirectory": () => import("../shared/localModelDirectory.js"),
  "shared/speechRequestAuthority": () => import("../shared/speechRequestAuthority.js"),
  "speechIngressStore": () => import("../speechIngressStore.js"),
  "shared/speechErrors": () => import("../shared/speechErrors.js"),
  "shared/speechTranscript": () => import("../shared/speechTranscript.js"),
  "shared/speechRecognitionMetadata": () => import("../shared/speechRecognitionMetadata.js"),
  "shared/speechControlContract": () => import("../shared/speechControlContract.js"),
  "shared/selectionSpeechContract": () => import("../shared/selectionSpeechContract.js"),
  "shared/performanceOperations": () => import("../shared/performanceOperations.js"),
  "runtime/pluginServicePort": () => import("./pluginServicePort.js"),
  "performance/performanceInstrumentation": () => import("../performance/performanceInstrumentation.js"),
  "peerTunnel/session": () => import("../peerTunnel/session.js"),
  "peerTunnel/http": () => import("../peerTunnel/http.js"),
  "manager/roleStorageApplication": () => import("../manager/roleStorageApplication.js"),
  "manager/scanController": () => import("../manager/scanController.js"),
  "runtime/protectedProcessLauncher": () => import("./protectedProcessLauncher.js"),
  "runtime/windowsProcessTree": () => import("./windowsProcessTree.js"),
  "shared/routeIdentity": () => import("../shared/routeIdentity.js"),
  "shared/napcatStateContract": () => import("../shared/napcatStateContract.js"),
  "shared/keyedAsyncLock": () => import("../shared/keyedAsyncLock.js"),
  "shared/homeMediaContract": () => import("../shared/homeMediaContract.js"),
  "shared/pluginStorage": () => import("../shared/pluginStorage.js"),
  "shared/filePersistence": () => import("../shared/filePersistence.js"),
  "manager/speechModelSettingsAccess": () => import("../manager/speechModelSettingsAccess.js"),
  "manager/lanAgentRequestAccess": () => import("../manager/lanAgentRequestAccess.js"),
  "manager/durableDeliveryIdempotency": () => import("../manager/durableDeliveryIdempotency.js"),
  "manager/connectionRequestAccess": () => import("../manager/connectionRequestAccess.js"),
  "automation/personaAutomationRuntime": () => import("../automation/personaAutomationRuntime.js"),
  "commands": () => import("../commands.js"),
  "config": () => import("../config.js"),
  "forwarding": () => import("../forwarding.js"),
  "history": () => import("../history.js"),
  "identityRelations": () => import("../identityRelations.js"),
  "manager/managerPluginRouteRegistry": () => import("../manager/managerPluginRouteRegistry.js"),
  "observability/dataMutationAudit": () => import("../observability/dataMutationAudit.js"),
  "routing/identityContext": () => import("../routing/identityContext.js"),
  "runtime/gatewayListenerRuntime": () => import("./gatewayListenerRuntime.js"),
  "scheduling/heartbeatSchedules": () => import("../scheduling/heartbeatSchedules.js"),
  "shared/gatewayConfigModel": () => import("../shared/gatewayConfigModel.js"),
  "shared/localSecretProtection": () => import("../shared/localSecretProtection.js"),
  "shared/mobileVoiceCall": () => import("../shared/mobileVoiceCall.js"),
  "shared/rabiMessage": () => import("../shared/rabiMessage.js"),
  "shared/timeoutSettings": () => import("../shared/timeoutSettings.js"),
};

export async function createMessageEndpointHostPorts(options: { loaders?: Readonly<Record<string, () => Promise<unknown>>> } = {}): Promise<MessageEndpointHostPorts> {
  const loaders: Readonly<Record<string, () => Promise<unknown>>> = { ...owners, ...options.loaders };
  const loaded = new Map<string, unknown>();
  const pending = new Map<string, Promise<void>>();
  return Object.freeze({
    async prepareModules(ids: readonly string[]): Promise<void> {
      await Promise.all(ids.map(id => {
        if (loaded.has(id)) return;
        const load = Object.hasOwn(loaders, id) ? loaders[id] : undefined;
        if (!load) throw new Error('Shared endpoint owner is unavailable: ' + id);
        let preparing = pending.get(id);
        if (!preparing) {
          preparing = Promise.resolve().then(load).then(owner => { loaded.set(id, owner); });
          pending.set(id, preparing);
        }
        return preparing;
      }));
    },
    module<T>(id: string): T {
      const owner = loaded.get(id);
      if (!owner) throw new Error('Shared endpoint owner is unavailable: ' + id);
      return owner as T;
    },
    assertModules(ids: readonly string[]): void {
      for (const id of ids) if (!loaded.has(id)) throw new Error('Shared endpoint owner is unavailable: ' + id);
    }
  });
}

/** Transport belongs to one activation; shared observational values retain their original owner. */
export function scopeMessageEndpointHostPorts(ports: MessageEndpointHostPorts, transport: Readonly<Record<string, unknown>>, inherited: readonly string[] = []): MessageEndpointHostPorts {
  const owned: Record<string, unknown> = structuredClone(transport);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  let namespace: unknown;
  return Object.freeze({ ...ports,
    module<T>(id: string): T {
      if (id !== "config") return ports.module<T>(id);
      if (!namespace) {
        const source = ports.module<{ config: Record<string, unknown> } & Record<string, unknown>>(id);
        for (const key of inherited) if (Object.hasOwn(owned, key)) owned[key] = structuredClone(source.config[key]);
        freeze(owned);
        const config = new Proxy(source.config, {
          get(target, key) { return typeof key === "string" && Object.hasOwn(owned, key) ? owned[key] : Reflect.get(target, key); },
          set(_target, key) { throw new TypeError(`Endpoint configuration is read-only: ${String(key)}`); },
          defineProperty(_target, key) { throw new TypeError(`Endpoint configuration is read-only: ${String(key)}`); },
          deleteProperty(_target, key) { throw new TypeError(`Endpoint configuration is read-only: ${String(key)}`); }
        });
        namespace = Object.freeze({ ...source, config });
      }
      return namespace as T;
    }
  });
}
