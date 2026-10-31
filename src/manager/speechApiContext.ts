import type http from "node:http";
import type { ManagerSpeechControl } from "./speechControl.js";
import type { SpeechRuntimeControl } from "./speechRuntimeControl.js";
import type { SpeechModelManager } from "./speechModelManager.js";
import type { SelectionSpeechSettingsStore } from "./selectionSpeechSettings.js";
import type { SpeechIngressStore } from "../speechIngressStore.js";
import type { SpeechMessageCommand } from "../shared/speechControlContract.js";
import type { SpeechAuthorityGuard } from "./speechRequestAuthority.js";
import type { PeerTunnelRuntime } from "../peerTunnel/runtime.js";

export type SpeechApiAdmission = Readonly<{
  guard: SpeechAuthorityGuard;
  run<T>(operation: () => T): T;
  selectedPeer?: Readonly<{ runtime: Pick<PeerTunnelRuntime, "session">; deviceId: string }>;
  targetLocal: boolean;
}>;
export type SpeechApiContext = Readonly<{
  speechControl: ManagerSpeechControl;
  speechRuntimeControl: SpeechRuntimeControl;
  speechModelManager: SpeechModelManager;
  selectionSpeechSettings: SelectionSpeechSettingsStore;
  speechIngressStore: Pick<SpeechIngressStore, "read" | "query" | "listDeliveryReceipts">;
  capture(request: http.IncomingMessage, computeDeviceId?: string): SpeechApiAdmission;
  readOnly(): boolean;
  identity(): { applicationGenerationId: string; managerInstanceId: string };
  hostSpeechCommand(body: SpeechMessageCommand & { gatewayId?: string }): SpeechMessageCommand;
  /** Only the local branch of seven native opaque proxy operations uses this original decoder (settings PATCH). */
  readProxyJson(request: http.IncomingMessage): Promise<unknown>;
}>;
