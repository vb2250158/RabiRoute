# Agent Hook performance timings

[简体中文](hook-performance-timing_zh.md) | English

Successful `POST /api/codex-hook/context` responses may include `data.timings`, an array of `{ name, startMs, durationMs }`. Times use a monotonic clock relative to entry into the Hook owner. Labels contain no request content, session identity, file path or credentials. Consumers must treat these optional diagnostics separately from business receipts; an absent timing does not imply a skipped business operation.

`context-build` covers queued context reads and assembly. Stop reports `plan-followup`, `chat-history`, `agent-request-stop`, `file-change-reminder`, `plan-completion` and `completion-delivery` when those operations run. Background work deferred after a file-change reminder is outside the completed request and is not presented as completed server work. Error responses retain their existing semantics and do not promise timing details.

DSH's Rabi adapter 0.13.42 records connection and server timings in its ignorable hook-result event. Performance statistics 0.1.10 shows them under the corresponding lifecycle event. Reported server durations occupy their enclosing API request; transport, queueing and other unmeasured time remain separate. Older logs retain recorded totals without reconstructed internal timings. The Manager API is shared with Codex; its optional measurements do not imply a Codex timing UI.

Stop resolves workflow configuration only for plans whose enabled completion hook belongs to the current session. Unrelated roles retain their configuration without workflow initialization or validation. Managed-task communication policy is queried only for `PreToolUse`; persona ownership and Stop plan-recovery checks still run at their original entry points.

An admitted remote Agent revalidates its computer credential at each connection check without also running WebGUI network-interface discovery. Browser credentials and relay generation/scope are still revalidated through their existing owners. No authorization result is cached across asynchronous work.

NapCat WebUI configuration discovery yields candidates in priority order and reads directories asynchronously. A matching configured file ends the search before unrelated installation trees are scanned. Health and account-owner checks also read WebUI and OneBot files asynchronously; account-owner checks still inspect fallback installations when needed. Discovered file paths do not cache credential contents, so token changes, file removal and disabled WebUI settings are observed on the next read. Slow fallback discovery no longer performs recursive synchronous directory reads on the Manager event loop.

Manager operational logs record `agent_hook_stop_stage` at the start and completion or failure of each measured Stop stage, including session and turn IDs and the HTTP request ID. A started stage without a terminal entry identifies unfinished work; it does not confirm a business result. `http_request_aborted` records a connection closed before its response finished, while normal responses retain only `http_request_completed`. These diagnostics contain no prompt, reply, tool arguments or credentials and do not retry, cancel or skip business work.
