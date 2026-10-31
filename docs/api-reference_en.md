English | [简体中文](api-reference.md)

# API reference and discovery

For integration developers: inspect operations published by the running service, request and response structures, and execution and recovery conditions. Start with the [user guide](user-guide/README_en.md) for ordinary configuration.

## Browse the reference

1. Open **User guide** in RibiWebGUI and select **API reference (developers)**. The direct route is `/#/docs?view=api` under the current WebGUI base; remote access retains its existing `/manage/…/` prefix.
2. Search names, paths, and descriptions; filter by module and HTTP method.
3. Select an operation to inspect its request, responses, effects, recovery rules, and named business validators.
4. Copy a request template or download OpenAPI. Supply the address, path and query parameters, body, and authentication for your current connection.

The page reads the catalog without invoking its business operations. Descriptions retain the declaring plugin's original language; interface labels follow the existing language selection.

## Source of truth

Each owning plugin maintains an executable API contract. HTTP dispatch, structural validation, help, and OpenAPI use the same active registration snapshot. The page neither scans function signatures nor maintains a separate operation list.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/agent/help` | Read operation contracts, filter by `operationId`, `method`, or `path`, and page with `limit` / `cursor`. |
| `GET /api/agent/openapi` | Download OpenAPI 3.1 generated from the same catalog. SSE, WebSocket, and native proxies retain their extension fields. |
| `GET /api/events` | Reuse the application's event connection; refresh on catalog changes and reconnection, without a documentation polling loop. |

The reference reads version 2 catalogs. It publishes a new display only after pagination completes. If a catalog change invalidates a cursor, it displays the error so the current snapshot can be refreshed. The page shows the last successful read time and reported coverage gaps.

## Discover the address and inspect operations

Use these PowerShell commands from a local source environment. Resolve the current address and verify runtime identity instead of fixing a port:

```powershell
$managerInfo = node scripts/resolve-manager.mjs | ConvertFrom-Json
$managerBaseUrl = $managerInfo.managerBaseUrl
$meta = Invoke-RestMethod -Uri "$managerBaseUrl/meta"
if ($meta.applicationGenerationId -ne $managerInfo.applicationGenerationId -or
    $meta.managerInstanceId -ne $managerInfo.managerInstanceId) {
    throw 'Manager identity changed; resolve the endpoint again.'
}
$catalog = Invoke-RestMethod -Uri "$managerBaseUrl/api/agent/help?limit=20"
$catalog.data.operations | Select-Object id, method, pathTemplate
```

Run from the source root, or use the resolver's configured absolute path. Remote access reuses an authenticated RabiLink or remote-computer connection; tokens stay in existing private connection configuration. The page uses WebGUI's address prefix and authentication without adding another secret. See [connections and API access](connection-access_en.md).

Success means `code: 0` and `schemaVersion: "2"`, with catalog generation and Manager identity matching the current service. `count` describes the current page; `total` describes matching operations in this catalog. A nonempty `nextCursor` means more pages remain.

## Coverage and errors

- `coverage.scope: registered-routes` limits the claim to registered routes; `globalCoverage: not-proven` means project-wide coverage is unproven.
- Each `coverage.gaps` item is a registration scope and may contain several endpoints. It is not a missing-endpoint count.
- Schemas describe declared fields and constraints. Open objects, native bytes, and passthrough proxies do not guarantee exhaustive business fields. The owning API still executes its rules.
- A catalog entry makes a contract discoverable. Check [current capabilities](current-capabilities_en.md) for acceptance involving accounts, hardware, networks, and real business effects.

| Condition | Action |
| --- | --- |
| `401` / `403` | Check connection authentication and explicitly disabled features. Discovery grants no additional permission. |
| `409` / `API_CATALOG_SNAPSHOT_CHANGED` | Discard the incomplete page set and refresh the catalog. |
| `404` or an older catalog version | Check the running version and published capabilities; do not substitute source inventory for online APIs. |
| `502` / `504` / timeout | Check the target PC and existing relay connection. Refresh after recovery; reconcile original receipts for uncertain business writes. |

## Maintenance

Update the owning plugin's contract, description, and implementation when changing an API. Parameters, responses, and recovery conditions follow the catalog. Maintain tutorials, business examples, and real-environment acceptance notes in both Chinese and English. This page stores no live operation count.

Further reading: [discovery architecture](api-contract-discovery-target-architecture_en.md), [Rabi Agent interfaces and business rules](rabi-agent-interfaces_en.md), and [migration progress](api-contract-discovery-implementation-progress_en.md).
