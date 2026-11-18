# NapCat API coverage and calls

[简体中文](napcat-api-coverage.md)

## Scope

The baseline is the NapCat 4.18.4 distribution with SHA-256 `66dfaa1b9e7530d493089c70d24810f4e23c31d129e1662949558ce30ce52a92`. The upstream repository currently retains its README only. Later releases require a new distribution audit.

[Native declarations](../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-4.18.4.json) describe 167 registered base actions, 501 names including aliases, 112 WebUI method/path pairs, 25 instantiated events and 6 event base classes. The [Rabi coverage matrix](../src/plugins/io.rabiroute.endpoint.napcat/contracts/rabi-coverage-4.18.4.json) records execution status, parameters, public response fields and exact dependencies.

| Area | This version |
| --- | --- |
| OneBot actions | 51 reads, including 19 limited views, and 55 mutations using the original durable ledger |
| Existing operations | 20 supported shapes under their original contracts |
| Outstanding implementation or native-host boundary | 41 individually documented items |
| WebUI | 17 reads/summaries plus 16 management operations (14 reads, 2 preference writes), 13 legacy entries, 58 dependencies and 8 host boundaries |
| Events | Typed metadata enters the original NapCat archive, while existing group/private message triggers remain active |

All base actions are discoverable. Missing execution owners return `QQ_API_OWNER_DEPENDENCY_UNAVAILABLE`. Compatible operations return `QQ_API_USE_EXISTING_OWNER`, with the original operation named in their contract. Discovery and actual execution coverage are counted separately.

The 19 added reads provide 3 handler-derived metadata views, 5 strict example profiles, 4 diagnostics and 7 credential summaries. `view` and `evidence` identify their scope. Example-shape mismatches return errors. Diagnostics exclude complete file, message and group data. Credential summaries expose presence, scope, type and expiry metadata.

## Calls

Discover an operation through `/api/search`, then read its help contract. Fixed actions use `POST /api/agent/qq/onebot/<action>`.

```json
{"routeId":"example-route","instanceId":"example-napcat","params":{"group_id":"100000001"}}
```

Mutations also require a stable `deliveryId`. The same ID and parameters consult the original durable record. Conflicting parameters return 409. A 202 leaves the original result uncertain. Query `GET /api/agent/qq/onebot-receipts/<deliveryId>?routeId=example-route&instanceId=example-napcat` and retain the original payload. `_async` and `_rate_limited` are discovery aliases for the same synchronous Rabi contract.

Actual calls bind a running Route, an explicit instance and the configured QQ account, verified with `get_login_info`. Existing connection authority, cancellation, deadlines, quotas and conversation scopes apply. Multiple configured instances still require an explicit `instanceId`.

Avatar, group portrait, OCR and voice transcription inputs use the original message-attachment owner. Supply `attachment={kind,targetId,messageId,attachmentIndex}` to identify an exact conversation and message. Caller URLs, host paths and arbitrary base64 cannot replace attachment identity.

Fixed WebUI reads use `POST /api/agent/qq/webui/<id>` with `routeId`, `instanceId` and `params`. The original WebUI session owner retains credentials and independently checks that its logged-in QQ matches the OneBot account. Certificates expose safe status summaries. Logs, pages and icons expose bounded summaries. SSE readers return bounded samples. This read interface excludes private keys, credentials, arbitrary proxies, host paths and plugin execution.

Management calls use `POST /api/agent/qq/webui-management/<id>`. Preference writes also require a stable `deliveryId`, with original receipts at `GET /api/agent/qq/webui-management-receipts/<deliveryId>`. They reuse the original login target and credential owner. Explicit logged-out state permits initialization under its contract. An observed native account must match the configured account. Unbound instances can use the original login panel to establish that binding. Theme updates preserve untouched fields, and automatic-login preferences do not submit a login. The native API lacks atomic CAS across clients, so readback and the original receipt determine the reported result.

## Joining groups

The 4.18.4 registration table contains no action for actively requesting membership in a specified group. `set_group_add_request` handles an already received application or invitation and needs its original event flag. `set_group_add_option` changes an existing group's admission settings. These findings cover this release's registered API. Other releases and client UI require separate verification.

## Verification and outstanding scope

Verification uses private ports, test configuration and mocks. In-use QQ accounts, player groups and NapCat services do not participate. Existing operations retain their supported shapes. Forwarding, cards, flash images and online folders with missing outbound producers remain outstanding. Credentials, host files, plugin management and native protocol execution stay with their respective owners, with per-item reasons in the matrix.

The plugin supports independent builds and rollback against a stable host contract. Publication requires the native/Web closure, cold start, interfaces and normal exit to pass against the installed host. The original plugin-catalog CAS selects the package, followed by an actual running-version readback. Source version, package hash, installation and real platform effects retain separate evidence.
