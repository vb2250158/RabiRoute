English | [简体中文](README.md)

# Workbench plugin

Provides independent canvas folders, graph execution, media editing, H3 generation and durable runs. The page is enabled by default; users start the GPU service explicitly. `host.manager.video@2` reuses process leases, original Agent delivery and the contract factory. `host.manager.operations@1` registers authenticated Manager APIs; events and the original conditional body reader still come from `host.manager.http@1`.

Media and new `/api/video/v2/*` Workbench endpoints share operation definitions and active discovery, including PNG/MP4/WAV, Range, SSE, independent canvas CAS and run receipts. The current plugin module creates and injects its native owner without wrapping the retired HTTP dispatcher. See the [media API contract](../../../../docs/video-api-contract_en.md) and [Workbench guide](../../../../docs/workbench-canvas_en.md) for directory layout, bindings, graph contracts and acceptance scope.

The Host provides `requestAccess(request)`; the plugin revalidates after asynchronous waits and before filesystem/process/network/stream dispatch. Accepted background tasks belong to the plugin lifecycle and do not retain initiating request authority. Revocation returns a sanitized 403; mutation outcomes distinguish `not_started` from `unknown` without claiming rollback.

See [Video generation plugin](../../../../docs/video-generation-plugin_en.md) for installation, APIs, data locations and acceptance boundaries. Models and private runtime data are not included in this package.

Damaged job and project files are isolated and retained unchanged. Status and project lists expose affected IDs, scopes and reasons in `recordIssues`; healthy records remain available. Identifiable damaged job keys remain reserved, and duplicate identities never execute automatically. If an original record cannot establish its idempotency key, only unmatched submissions in that job domain (local or compute) return 409. Existing valid receipts, the other domain, model management and projects remain usable. Restore the original file and reload the plugin to recheck it; do not resend under a different ID.
