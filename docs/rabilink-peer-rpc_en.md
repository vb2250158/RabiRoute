# Cross-PC connection signalling and discovery

English | [简体中文](rabilink-peer-rpc.md)

Status: experimental, current source contract. This page covers discovery and retained control signalling. All business reads, writes, streams and third-PC capabilities use [generic connections](rabilink-peer-tunnel_en.md). Local automation does not establish physical dual-PC acceptance or remote deployment.

## Discover a target PC

Enable the same RabiLink application on both endpoints. Discover the current `managerBaseUrl` from Host `status --json`, then check `/meta` for application generation, Manager instance and readiness required by the target API before querying:

- `GET /api/rabilink/peer/list`: registrations and categorized `summary` counts, with device ID, GUID, `deviceKind`, presence, capabilities and LAN addresses.
- `GET /api/rabilink/peer/list?deviceKind=pc&online=true`: explicitly classified online PCs, with counts matching the filtered result.
- `GET /api/rabilink/peer/servers`: current connectivity, actual transport and RTT, as documented on the generic connection page.

PCs report `deviceKind=pc`; phones, glasses and extensions keep their own types. Missing or invalid types become `unknown`; names and capabilities never imply hardware. `summary.total` counts registrations. Relay preserves a registered type when a later client omits it; historical entries require a fresh device report. Types and versions identify installations but grant no authority.

Discovery controls accept safe local access or Manager-ingress-authenticated connections. Real remote Agent principals take precedence; revocation cannot fall back to loopback access, and forged headers cannot establish a principal. The separate peer LAN listener exposes only encrypted protocol and tunnel handshakes, never full Manager or WebGUI controls directly.

## Signalling control plane

The business `POST /api/rabilink/peer/call` endpoint is removed and returns 404. The old `plans.list` / `persona.manifest` registrations, manifest helper and per-business-call P2P caller are also removed. There is no second business dispatcher.

The retained encrypted wire accepts only:

| Operation | Purpose |
| --- | --- |
| `system.describe` | Confirm device, generation, Manager instance and enabled control signals |
| `transport.tunnel` | Application bootstrap and generic WebRTC or Relay tunnel negotiation |
| `transport.offer` | Control DataChannel receiver compatibility for supported older phones |

The dispatcher will not execute or advertise obsolete business operations even if they are accidentally registered. Disabled applications cannot allocate connections. Describe metadata identifies connection allocation as control traffic rather than a read-only operation. Retired `peer-access.json` files never grant authority.

PC signalling uses the existing `/api/rabilink/peer/proxy` to deliver ciphertext to the target's `/api/rabilink/peer/receive`. A describe exchange precedes one allocation bound to the current generation/instance. Changed credentials, cancellation, identity mismatch or instance replacement fail closed. Each signalling HTTP exchange has a five-second budget. Unknown allocation results are never replayed across LAN/P2P/Relay. Expiry and packet sizes are bounded; plaintext is limited to 1 MiB. Business transport selection and connection reuse belong to the generic tunnel.

Requests and replies use application-derived AES-256-GCM. Local or remote Agent administration does not replace application isolation, target identity or generation checks. Relay forwards to the fixed target rather than an arbitrary local URL. Plugin disposal closes channels and drains accepted HTTP work.

## Access all business APIs

Public target-PC APIs execute through the `manager` service, for example:

~~~text
GET /api/rabilink/peer/http/pc-b/manager/meta
GET /api/rabilink/peer/http/pc-b/manager/api/agent/help
~~~

New Manager APIs and public headers require no Relay dispatcher additions. All three transports share encryption, multiplexing and authorization. LAN is preferred, then P2P, then Relay; healthy connections are reused. Third-PC access uses existing nested forwarding, limited to four hops with repeated or self-targets denied. [Generic connections](rabilink-peer-tunnel_en.md) define HTTP/SSE/WebSocket/binary, no replay of uncertain writes and mid-stream revocation.

Personas do not determine permissions. Existing persona, plan and chat-history APIs on the source PC remain the data owners; remote access creates no synchronized replicas. The old manifest API is unnecessary to retain data. Existing user data and conflict evidence remain intact. Video retains its separate no-video-relay contract.

## Compatibility exit and acceptance

The old `transport.offer` receiver retains control wire only for supported clients. Business requests have one generic `manager` path. Remove the old DataChannel receiver after supported clients migrate to `transport.tunnel`, old usage reaches zero and device acceptance is complete. The generic connection page defines exit conditions for legacy bootstrap signatures and the persona-page bootstrap alias.

All 66 focused transport tests passed, covering real local WebRTC, isolated Relay, LAN forwarding across three runtimes, unknown endpoints and business headers, stream revocation, cancellation and no replay of unknown results. Entry points are `src/rabiPeer.test.ts`, `src/rabiPeerClient.test.ts`, `src/manager/rabiPeerRoutes.test.ts` and `src/peerTunnel/` tests. Physical dual-PC operation, cross-carrier P2P, sustained operation and phone/glasses upgrades still need separate runtime evidence; this page makes no deployment or physical-acceptance claim.
