# Configuration surface compatibility contract

English | [简体中文](config-surface-compatibility.md)

The HEAD audit required `remoteAgentDefaultDeviceId` in WebGUI even though its two inspected Vue files no longer contained that field. This was an existing contract mismatch, not introduced by the AIUI tool changes.

`remoteAgentDefaultDeviceId`, `remoteAgentDefaultCwd` and `remoteAgentDefaultThreadName` remain active compatibility defaults. GatewayDefinition preserves them; Manager `controlPlaneRoutes.ts` uses them when a remote task omits deviceId/cwd/threadName, and `routing/agentPacket.ts` still produces corresponding API guidance. AIUI advanced configuration retains these values. They are not retired, automatically migrated or equivalent to the new UI.

Current WebGUI uses `remoteAgentTargets`, instance/Agent bindings and `InstanceAgentSettings`. The audit classifies only these three defaults as compatibility schema/runtime/AIUI advanced fields, rather than requiring removed controls in current WebGUI. Current instance bindings are mandatory; unknown shared schema fields and deleted bindings still fail. Configuration does not select AIUI inference ownership: local remains the default, remote observation requires explicit selection.

Local compatibility tests passed 3/3; the configuration surface audit passed for 119 shared fields, 45 direct fields and nine action groups. These counts are structural audit evidence, not complete feature or device acceptance. Full check then exposed another HEAD contract mismatch: the old standalone `RokidDeviceStatusSyncService` no longer exists; the existing `RabiConversationService` owns `RabiGlassStatusPublisher`. This was not merely missing snapshot files.

The bridge audit now verifies that implementation: actual battery/charging callbacks, running/statusSyncEnabled/uploadEnabled consent gates, frozen credential identity, network-restoration drain, close lifecycle, non-exported owner and no new CXR/UI control. Four positive/negative tests and the bridge audit passed. Removing gates or owner callbacks/drain/close, or injecting UI control fails. Relay, SDK, stale-safe AIUI and original status-only CXR boundary checks remain. No standalone service was introduced or Android production code changed. This does not claim full check or device acceptance. Business configuration, existing values and runtime migration behavior were not changed.
