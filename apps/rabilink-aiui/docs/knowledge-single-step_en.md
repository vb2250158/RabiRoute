# Single-step knowledge tools (experimental)

English | [简体中文](knowledge-single-step.md)

`utils/knowledge-tool-runtime.js` does not modify the page or authenticate transport. Inject `list`, `call`, and atomic `storage.load/save`. Transport uses the existing device credential at fixed `/api/rabilink/device/knowledge`, unwrapping `{code:0,data}` first. Catalogs must contain `tools` and server-owned `allowedRoles`. Explicit user role selection must match both trusted caller policy and catalog policy; never infer authorization from a profile ID.

Only six read tools are advertised; `memory_get` accepts `consolidated` only. PC still validates authoritative argument schemas. Complete events require `isComplete:true` and stable `callId`. Persist intent before dispatch, reject conflicting reuse, never retry automatically. The caller scopes the ledger to device ownership and a bounded session; its 128-entry capacity fails closed.

Concurrency is one. Timeout is not cancellation: an unsettled transport keeps its concurrency slot. `cancelPresentation()` suppresses presentation only, not PC execution. Disposed runtimes cannot execute.

Results must be official MCP `CallToolResult`. Only `structuredContent.ok=true` without uncertain/isError produces success presentation. Speech uses fixed summaries and counts, never arbitrary tool prose; detailed results are untrusted text. Results are separate from model answers, never injected as fake continuation prompts. Official 0.18 documentation does not establish a tool-result continuation API.

Local pure-JS tests cover role/write rejection, deduplication, persistence failure, concurrency, cancellation and timeout. The main page is now wired through the page-method module; see the [page contract](knowledge-tool-page_en.md). Real-device acceptance remains pending; these tests do not prove that a deployed PC bridge is running.
