**English** | [简体中文](external-listener-contracts.md)

# Public contracts for independent listeners

Independent HTTP / WebSocket listeners retain their ports, handlers and authentication while participating in unified discovery. Public native HTTP operations can use the established Manager connection. Manager binds the original HTTP exchange to a real listener lease; the original listener remains the business owner.

## Registration and invocation

After the original listener successfully starts, its runtime owner calls `ManagerPluginRouteRegistry.registerExternalListener(instanceId, definition)`. Plugins may use `ManagerApiOperationsService.registerExternalListener(definition)`; identity comes from the current plugin activation.

```ts
const listener = registry.registerExternalListener("native-owner", {
  listenerId: "callback.listener",
  address: { protocol: "http", port: actualPort },
  protocol: "native-callback",
  invocation: "native",
  authentication: { kind: "none", description: "Original listener admission." }
});
listener.registerHttpProxies(nativeDefinitions);
// Delegate the original HTTP callback to listener.handle(request, url, response).
// Delegate the original upgrade callback to listener.handleUpgrade(request, url, socket, head).
```

`registerOperations`, `registerHttpProxies` and `registerUpgrades` reuse contract compilation, validation, request tracking and shutdown. To retain original body parsing, non-JSON errors, unknown query parameters or status codes, use a formal HTTP passthrough contract with the original handler. Replacing its decoder with the generic JSON decoder does not preserve that behavior.

`address` describes an existing listener and never starts a service. An explicit hostname must be a hostname or IP, without URL credentials, paths or wildcard bind addresses such as `0.0.0.0` / `::`. The receiving Manager selects the original lease address; an omitted hostname resolves to its own loopback. Clients do not scan or configure per-operation ports or open NAT ports. Protocols retaining the direct connector use their explicit native address; loopback addresses are directly reachable only locally.

Each listener has its own path space. The same `POST /callback` may exist on Manager and several listeners; operation IDs and aliases must remain unique. Each discovery entry's `binding` contains the address, protocol, authentication description and a nonsecret `leaseId`. Address or listener generation changes require the original owner to register a new binding.

`invokeOperation()` prefers `access.kind: "manager-native-http"` from the same catalog. Its address consists of `/api/native-listeners/<original-lease>` and the original contract path, never an arbitrary URL or unregistered listener. The receiving Manager fixes the target authority, rejects leading `//` in the native path, and preserves internal double slashes and query bytes. Only the original owner decodes the body. HEAD, original statuses, repeated public headers and same-origin redirect lease paths are retained. Cross-origin Location is returned unchanged; the connector never follows redirects automatically.

Before dispatch, the connector checks authenticated Manager identity, the binding, access mapping and contract digest. Outer Manager transport and original native contracts use separate headers. The native listener receives only its own contract digest and `x-rabiroute-listener-lease`, without node Bearer, cookies, Agent identity or Manager generation headers. Manager captures both identity fields at admission and rechecks them across awaits, disclosure and stream chunks. A plugin projection change retaining the same original Gateway lease does not cancel accepted calls. HTTP checks the binding again afterward. Stale leases reject new dispatch; post-write replacement remains uncertain and never replays automatically.

The current Manager mapping covers public HTTP contracts with `invocation: "native"` and no additional native authentication, reusing the existing Manager LAN / P2P / Relay connection. Native WS and additional native authentication retain the direct connector; not all WS operations are Manager-mapped. Explicit `nativeHeaders` supplies original target Authorization / Cookie credentials separately from Manager Bearer. Node credentials cannot be reused as native credentials. These inputs never enter discovery or pass through the current Manager HTTP mapping.

Calls never replay automatically. If post-dispatch HTTP binding verification fails, the receipt includes `bindingChanged: true` and `uncertain: true`; retain original request keys and inspect the original outcome. Streaming, file output and WebSocket retain the generic connector's explicit consumer, backpressure and cancellation contracts.

## Publication across processes

An independent Gateway process publishes `listener.publication()` through its existing lifecycle or IPC. This contains `active`, the binding and `{ contract, contractDigest }` from actual executable registration. Stopping admission publishes `active: false`, removing the listener from discovery even while its Gateway process remains alive.

The existing Manager runtime owner calls:

```ts
const unregister = managerRegistry.registerExternalListenerSource("gateway-owner", {
  isCurrent: () => existingGatewayLeaseIsCurrent(),
  read: () => verifiedGatewayPublications()
});
```

Trusted local runtime code supplies `isCurrent` and `read`. Wiring verifies the original child object, PID, Gateway ID, original generation and increasing publication revision. Arbitrary HTTP requests, static configuration or unverified files cannot establish an active publication. Manager validates fields, recompiles contracts and compares digests; invalid publication produces an explicit gap. Manager owns the long-lived stdout parser, UTF-8 partial line and verified cache; plugin activations only project that cache. Replacement, failed candidates and rollback neither restart the child nor fabricate or replay publication.

Retirement removes the source and refreshes publication. Its owner awaits `drainRetiredNativeListenerHttp()`, joining only removed bindings. Final Manager shutdown stops ingress and awaits `disposeNativeListenerHttp()`. Repeated closes and failures preserve the same final disposal Promise; a disconnected HTTP response does not establish producer closure. Normal stopAccepting retains cleanup of business work already admitted by the original owner. Unknown outcomes never authorize replay.

This API supplies the process publication boundary. Gateway-specific IPC / status wiring and runtime acceptance remain the corresponding owner's responsibility; an in-memory catalog alone does not establish cross-process integration.

## External protocols and discovery format

Listeners requiring platform signatures, URL challenges, OneBot reverse frames or Peer control handshakes use `invocation: "discovery-only"` unless a compatible native protocol connector exists. Discovery and help expose the protocol and original authentication. Ordinary node authentication never substitutes for platform authentication. A generic call explains that the native connector is required and does not dial the target.

Public Rabi business APIs must publish the native invocation they actually support; platform classification cannot hide business endpoints. The permission model remains unchanged: authenticated remote connections default to public Manager capabilities. The catalog provides discovery and address selection.

Help and capabilities return `binding` on each independent operation and an explicit `listeners` inventory, including internal transport-control listeners with no public business operation. Internal contracts do not become public business capabilities. OpenAPI keeps Manager operations in top-level `paths` and puts independent address spaces under `x-rabiroute-external-listeners` as `{ binding, owner, paths }`, retaining identical method/path pairs on different listeners. HTTP wildcards, raw suffixes and upgrade contracts keep their existing extensions.

`help.coverage` describes schema precision separately for paths, queries, headers, bodies and responses, including opaque bytes, open provider data and stream frames. `auditLevel: "runtime-schema"` means that declared schemas execute. `exactRequestSchema` / `exactResponseSchema` conservatively remain false, and `completeness: "not-proven"` explicitly leaves complete native DTOs unproven. Native owners retain business validation. Precision reporting never narrows accepted fields.

Internal `//` in native paths is preserved during matching and invocation. Leading `//` remains rejected to prevent cross-origin targets. A final native static-resource fallback declares `httpProxy.dispatch: "final-fallback"`, `method: "*"`, `pathTemplate: "/:suffix"` and `request.pathRemainder: "suffix"` through the existing `registerHttpProxies` API. Ordinary operations, native wildcards, legacy routes, upgrade checks and known-path 405 responses take precedence. Each listener permits one such fallback owner. Its presence does not prove coverage of unregistered business APIs.

## Verification scope

Tests cover real child stdout publication, Manager-only access, an actual encrypted TunnelSession, opaque bytes, independent path spaces, stale leases, SSRF authority confinement, double-identity response fences, native early responses during unfinished upload, producer-close gates, explicit native credentials and repeated shutdown. They send no real platform messages. Actual LAN / P2P / Relay network connectivity and production Supervisor wiring require their own runtime acceptance.
