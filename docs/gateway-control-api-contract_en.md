<!-- docs-language-switch -->
<div align="center">English | <a href="./gateway-control-api-contract.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Executable contracts for gateway runtime control

> Status: source migration and focused isolated verification. Full builds, installed releases and physical cross-computer acceptance require separate overall verification.

`io.rabiroute.manager.gateway-runtime` publishes 15 business operations through `createGatewayControlOperations(context, managerReadOnly)`. The same definitions install routes, validate requests and responses, and populate the API catalog, replacing the previous exact/prefix declarations and `handleGatewayControlApi` HTTP dispatcher. `createGatewayControlOwner()` directly invokes the existing configuration transactions, runtimes, delivery and process owners, without a second Route state or Runtime.

## Operations

Operation IDs use the `manager.gateway-runtime.` prefix and remain public. Authenticated remote connections use the same owners by default, retaining explicit user disables and original parameter, object, read-only and transaction rules.

| ID suffix | Method and path | Native result |
| --- | --- | --- |
| `list` / `replace` | GET / POST `/gateways` | Read or replace Routes; writes return their commit receipt |
| `config.save` | PUT `/gateways/:id/config` | Merge one Route and report persistence separately from activation |
| `mutation.read` | GET `/gateways/mutations/:operationId` | Confirm committed / not_committed after the original transaction queue barrier |
| `start` / `stop` / `restart` / `delete` | POST `/gateways/:id/start`, `stop`, `restart`, `delete` | Original runtime requests or configuration deletion transaction |
| `weixin-login.request` | POST `/gateways/:id/weixin-login` | Original adapter QR-code request; acceptance is 202 |
| `manual-trigger.request` | POST `/gateways/:id/manual-trigger` | Original process acceptance or already-running result, status 202 |
| `agent-delivery-test.request` | POST `/gateways/:id/agent-delivery-test` | Await the original target's real test delivery receipt |
| `delivery-replay.list` / `delivery-replay.request` | GET / POST `/gateways/:id/delivery-replay` | Read original attempts or request replay; replay acceptance is 202 |
| `network-options.read` | GET `/network-options` | Original network configuration options |
| `reload` | POST `/reload` | Await original reload and synchronization; JSON 200 or empty 303 |

Lifecycle `requested` and process `accepted` do not prove startup, shutdown or completion. Delivery tests and replay produce real messages in a running application. Isolated tests replace only the original call boundaries and contact no real Agent, platform or process.

## Inputs, recovery and retirement

Route mutations and deletion retain the original `Idempotency-Key` and strong `If-Match`. Preparation checks original request conditions before consuming the body; it never invents a replacement key. Writes still use `writeConfig`, `writeGatewayConfig` and `removeGatewayConfig`, without copying their transaction, CAS or durable receipt implementation.

A scoped save keeps `receipt.state=committed` if runtime activation fails, reporting that failure through separate `activation` data. For uncertain results, query the original queue-barrier receipt using the original operationId. Absence of an HTTP response does not mean the write did not commit. Process, delivery, replay and reload operations have no request-level idempotency: inspect original state and receipts before deciding whether to repeat them.

Contracts discard natively ignored bodies without parsing them. JSON endpoints retain the empty-body `{}` default, arbitrary Content-Type, unknown fields, native coercion and the original absence of an application byte limit. `managerReadOnly` remains an execution mode and rejects write methods before consuming a body.

The registry now owns protocol decoding: malformed JSON returns 400, replacing the previous manual-trigger, delivery-test and replay classification of decode failures as 500 / 502. Native business failure statuses remain unchanged. Unsupported methods on registered paths return 405 with `Allow`, including previously falling-through GET `/reload` and PUT `/gateways`; no extra rejection-operation table is maintained. Unrelated paths still fall through. The existing production error presentation adds `reason` and bilingual `errorMessages` as before.

`/reload` retains its original Accept substring test: an `application/json` substring returns `{ok,gateways,routeCatalog}`; other values return 303, `Location: /` and an empty body. The catalog describes both responses without requiring a dedicated remote mapping.

The plugin retains its original runtime lease. Retirement first stops new API admission and joins accepted operations, then lets the original lease owner decide whether to stop manual processes and all gateways. HTTP disconnection does not release an accepted operation early. Revoking the original Node hides business data at the common boundary while retaining uncertainty about a possible commit.

## Verification scope

Focused tests run the real contract registry and isolated HTTP servers. They cover public calls after real Node enrollment, native business results, preconditions before bodies, read-only mode, scoped persistence versus activation, queue recovery receipts, 303/Location, 405/Allow, temporary-file readback of an original-key write after revocation, and operation leases after disconnection. Runtime, platform and delivery boundaries remain controlled fixtures. These results do not establish real-process or physical cross-computer delivery acceptance.

See the [target architecture](api-contract-discovery-target-architecture_en.md) and [implementation record](api-contract-discovery-implementation-progress_en.md) for overall acceptance.
