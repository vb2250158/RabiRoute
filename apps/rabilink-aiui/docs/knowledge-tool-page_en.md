# AIUI knowledge tool page integration

English | [简体中文](knowledge-tool-page.md)

Status: page methods and actual main-page wiring implemented; local knowledge, profile, model-generation and runtime-owner checks passed. Local AIX test packages have been built and parsed; the acceptance matrix tracks the latest integrated regression. Formal installation and device acceptance remain pending. The HUD shows at most 22 characters of separate tool status; tapping refreshes both device settings and the knowledge catalog. Detailed results remain text data, never model input.

Enable the MCP reference `id: "rabi-knowledge"` in the device profile to select this controlled service. This is not authorization. The catalog must be fetched using the real device credential and provide authorized roles. The user must explicitly say “使用知识角色 <ID>”; the ID must belong to that catalog. Even a single role is never selected automatically. No knowledge tools are advertised before selection.

Application receipts are confirmed only when the current model has registered read-only tools, scope/role/catalog still match, and every enabled service is `rabi-knowledge`. Unknown services and pending rebuilds remain unavailable. The status explicitly states that model/read tools are applied and writes remain disabled.

Main-page wiring:

1. Import/spread `knowledgeToolPageMethods`. Use bounded HUD display copies rather than rendering raw results across the page. Only explicit “读出工具结果” or “下一条工具结果” commands display and speak a result segment in the reply area; see [result reading](knowledge-result-view_en.md).
2. Refresh the catalog after device-profile application and on explicit user refresh; add no polling. Check `selectKnowledgeRoleFromSpeech(text)` before ordinary conversation dispatch.
3. Call `applyPendingKnowledgeTools()` before marking a new turn busy. Role/catalog changes take effect next turn without interrupting inference.
4. Before model creation, call `prepareKnowledgeTools()` and append its tools to model options. Capture its returned runtime in that model's event listener and pass it to `handleKnowledgeToolCall`; never substitute a later model's global runtime.
5. Call `cleanupKnowledgeRuntime()` on model release and `cancelKnowledgePresentation()` on cancellation. Neither claims to revoke an already-dispatched PC request. Invalidate tools when device ownership changes.

The dedicated wx ledger retains only the credential-fingerprint scope, increasing model-session counter and up to 128 current-session call records. Persist before dispatch; duplicates are not resent. Raw credentials are not stored. Results use text and a fixed summary, never executable content or a fabricated model continuation. Only read tools are advertised; recent-memory touch and writes are excluded.
