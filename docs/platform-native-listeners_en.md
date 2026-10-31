English | [简体中文](platform-native-listeners.md)

# Feishu and NapCat native listener protocols

Status: source implementation and controlled local HTTP/WS regression. Real platforms, installed release and cross-process catalog aggregation require separate acceptance. This page is for maintainers; user setup is in [Feishu integration](feishu-integration_en.md) and [NapCat management](napcat-unattended_en.md).

## Protocol boundaries

| Entry | Address and requests | Original authentication |
| --- | --- | --- |
| Feishu | Original feishuWebhookPort, loopback by default; POST only, exact URL.pathname against feishuWebhookPath | Verification Token for challenges; token, raw-byte signature and five-minute window for events; verify before decrypting encrypted events |
| NapCat | Original per-instance gatewayPort, always 127.0.0.1; NapCat WebSocket Client connects to the RabiRoute reverse WS server, accepting any upgrade path | No inbound password, verifyClient or path authentication; Access Token belongs to outbound OneBot HTTP |

Both retain independent addresses, stay outside Manager and open no additional listening ports. Manager/node bearer credentials cannot replace Feishu verification and are never forwarded to platforms. NapCat gains no inbound password or feature grant.

Feishu does not normalize paths: case, repeated slashes, encoding and trailing slashes retain the original pathname comparison; query is excluded. Raw bytes and arbitrary Content-Type are preserved. The limit is 1 MiB (413); wrong method/path is 404, invalid JSON 400, invalid token/signature 401, accepted/ignored/duplicate events 200. Challenges return the original challenge object.

NapCat retains ws native handshake, parsing, ping/pong, text/binary frames and default 100 MiB maxPayload. Ordinary HTTP remains 426. Invalid handshakes retain the ws response without appending another error. Group/private mapping, instance identity and the source instance's outbound endpoint keep their original owners.

## Executable owners and binding

feishuHttpOwner.ts accepts IncomingMessage/ServerResponse and reuses handleFeishuCallback, appId/chat/message/event identity, durable deduplication, status and forwarding callbacks. napcatWsOwner.ts owns the original loopback HTTP listener and noServer WS server. The shared registry's upgrade handler invokes that same server.handleUpgrade; the adapter retains business mapping.

platformNativeOperations.ts declares contracts and address bindings. Actual traffic passes through the existing ManagerPluginRouteRegistry.registerExternalListener, with no parallel registry. Publications contain the actual bound port, protocol, authentication description, lease and contract digest, without platform secrets or handlers. Local names are gateway.feishu.<actual-port>.callback and gateway.napcat.<instance-digest>.<actual-port>.events. Production adds the original Gateway digest namespace through the shared runtime, keeping processes and addresses distinct.

The /:nativePath raw remainder covers the original server URL space; Feishu still owns its exact business path. Production defaults call getGatewayListenerRuntime() directly and publish/withdraw actual bindings over the original Gateway stdout/supervisor IPC. Gateway ID, generation and PID come from the host; missing identity fails instead of creating a temporary identity or registry. Controlled tests may explicitly inject apiOperations.registerExternalListener; publishListener is an observer/test hook. The shared runtime/supervisor owner verifies process and lease. Both platforms are discovery-only: catalog descriptions do not turn platform protocols into generic Manager JSON calls or bypass platform authentication.

## Lifecycle

Feishu leases cover body parsing, accepted forwarding promises and responses. Shutdown stops admission, closes real connections and joins accepted work. Caller disconnect does not release an executing callback early.

NapCat leases cover actual socket closure and accepted frame/profile promises, including startup profile refresh. Shutdown stops upgrades, terminates sockets, waits for real HTTP/WS close callbacks and joins all work. Repeated dispose calls await the same promise. A cancellation signal enters the typed frame context; already started effects are never automatically replayed.

## Controlled validation

```powershell
node --test-concurrency=2 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/adapters/feishuAdapter.test.ts src/adapters/napcatAdapter.test.ts src/adapters/platformNativeOwners.test.ts src/adapters/platformNativeGateway.test.ts
```

Temporary directories, random local ports, simulated signatures and injected callbacks cover exact paths, raw signatures, challenges, errors, byte limits, deduplication, withdrawal, arbitrary WS paths, text/binary frames, original handshake errors, instance identity, callbacks after disconnect, startup cleanup and port remount. No platform login or real messages are performed.

The default-path child regression injects neither apiOperations nor publishListener. It verifies actual shared-runtime stdout messages, PID/generation, namespaces and both bindings, executes a Feishu challenge and arbitrary-path OneBot frame, and verifies complete withdrawal before exit.
