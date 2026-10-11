<!-- docs-language-switch -->
<div align="center">
English | <a href="./agent-endpoint-delivery.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Exact Agent delivery and formal replies

This developer document describes the new Manager delivery contract. Source fixtures cover persistence, identity revocation, device sources without working directories, and formal replies. Installed packages, connections between PCs, glasses wake, and ASR/TTS require separate acceptance. See [Connection and API access](connection-access_en.md) for public API access after authentication.

## One execution path

Agent `send` and `reconcile_delivery` use `createAgentEndpointDelivery` and the PC-owned `AgentRequestStore`. Sources and targets may be local hosts, managed remote instances, or native device Agents. An adapter passes the prepared message to its exact owner and returns that owner's receipt.

The delivery record retains complete source and target identities, the original message, `deliveryId`, `generation`, prompt and execution-option hashes, and the authorization incarnation. Session IDs are complete opaque values; they are never truncated or replaced through name lookup. A device endpoint also fixes its owner PC, device, session, and owner epoch.

A connected transport, queued message, or phone-submitted wake action does not establish owner acceptance. A native device must claim the message through its authenticated original session before a matching receipt exists. Providers without a working driver report the missing capability and never start a fallback Runtime.

## Source identity and execution directories

Managed connections and current host records establish source identity. Glasses sources use a signed connection principal supplied internally; request bodies cannot supply that authority. The principal is captured when entering delivery, and the original connection is checked again after asynchronous reads and before sending. Failure to resolve the original device source cannot fall back to another source from the request body.

A local Manager hop uses a process-issued MAC and a single-use nonce bound to the application scope, source, current generation, method, and actual HTTP target. Bare proxy headers and public generation values cannot establish device identity. Relay issues a fresh proof for each HTTP attempt without handing the credential to an external worker.

A source does not require `cwd`. Glasses use the Rokid-configured runtime and model and do not accept PC working-directory, model, reasoning-effort, or sandbox options.

A PC target that needs an execution directory requires an existing absolute directory consistent with that owner's execution contract. Configured workspace lists no longer authorize public API access or exact delivery. Persona and message-route bindings do not restrict API access. Directory checks establish execution context and prevent delivery to the wrong owner; they do not decide who may call public APIs.

## Formal replies and uncertain outcomes

A formal reply includes the original `requestId` and must reverse the exact original source and target, including owner, session, Agent type, and authorization incarnation. Device reply parameters include `instanceBinding` and `agentAdapter: "deviceAgent"`; no device working directory is required.

A send timeout or missing receipt returns `delivery_unconfirmed`. Callers query or reconcile the original `deliveryId`. `reconcile_delivery` reads existing evidence without creating another delivery. Recovery after restart retains the original record and cannot replace the session, credentials, or owner, or replay a message whose attempt already began.

Revoked identity, a changed device owner epoch, an archived session, or mismatched receipt hashes prevent confirmation. A new binding is not a receipt for the original delivery, whose uncertain outcome must remain visible.

Device delivery between PCs distinguishes the ledger Manager from the physical device owner: `managerInstanceId` identifies the Manager holding the original delivery record, while device `instanceId` identifies its owner PC. Preparation, sending, reconciliation, and receipt confirmation asynchronously refresh both endpoint proofs and compare them with the original endpoints. Refresh verifies the original identity; it cannot replace the recorded session or epoch.

The original source owner must remain loaded. An unloaded target may queue a message and await wake. Checks refresh the source, target, then source again so waiting for target evidence does not overlook source loss. Synchronous authorization also distinguishes source and target roles; target queueing does not relax source requirements.

`GET /api/agent/delivery-authority` is a public API for authenticated connections and does not require a target-session binding. It returns the original ledger identity, source, target, preparation parameters, and hashes without the message body. The original connection and reservation identities remain subject to validation. The execution owner must additionally verify that the sending connection belongs to that ledger PC and query the original reservation. Reading reservation evidence does not itself permit execution.

An explicitly `cancelled` original record returns HTTP 200 with `authorized: false` and its original identities and hashes. This reports cancellation without requiring the old source to remain loaded or its old epoch to remain executable; it never permits a send. Only after matching this evidence against the original transport record may the device mark that record as outcome unknown and continue its queue. Original business data remains, and the cancelled delivery is never marked accepted. Unknown records, generation mismatches, and invalid current reader connections remain denied.

Implementation: `src/manager/agentEndpointDelivery.ts`, `src/agentRequests/endpointDelivery.ts`, `src/agentRequests/ownerExecution.ts`, and `src/manager/deviceAgentEndpointBridge.ts`. See [Native device Agents](device-agent-adapter_en.md) for device integration.
