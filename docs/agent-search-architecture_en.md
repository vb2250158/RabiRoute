English | [简体中文](agent-search-architecture.md)

# Unified agent search

`GET /api/search` brings together candidate plans and memories, messages, registered operations, and available device entities. Active operation contracts declare the sources; the knowledge, message, operation catalog, and device owners still provide their own data. Search does not replace their detail or execution contracts.

## Use

Locally, run `node scripts/resolve-manager.mjs` and verify identity with `/meta`; remotely, use an existing authenticated connection. Send `GET /api/search?q=<URL-encoded keywords>` to the current Manager. Alternatively, discover `manager.search` with MCP `rabi_search`, inspect its contract with `rabi_describe`, and invoke it with `rabi_call`, or use CLI `--operation manager.search`. Caller identity headers are optional metadata, not authentication credentials; connection authorization and user settings still apply.

| Parameter | Purpose |
| --- | --- |
| `q` | Keywords; omit to browse |
| `scope`, `kind` | Sources and kinds from response `capabilities` and `legend` |
| `agent`, `adapter` | Optional role or message adapter; an unknown role returns `AGENT_NOT_FOUND` |
| `from`, `to` | Observation-time bounds in Unix seconds |
| `match`, `mode`, `strict` | Keyword matching, search mode, and strict scope |
| `limit`, `cursor` | 1–200 items per page, default 20; continue with the returned opaque `nextCursor` |
| `sort`, `includeArchives`, `budgetMs` | Sort order, message archive scope, and remaining budget |

Keep filters and page size unchanged across pages. A change in Manager identity, role scope, or source version expires the cursor; restart from the first page on 409. `expand` is not implemented. `scripts/lib/query-rabi-search.mjs` shares one caller budget across discovery, identity checks, the request, and response reading. It reserves 20% of the remaining budget, capped at 500 milliseconds, for response delivery and body reading so a slow source can expire while other results and coverage gaps still reach the caller.

## Test from the page

On a persona’s Message history page, select Search API test beside Refresh channels. Choose a caller identity and persona scope, enter keywords and select a source, then search. Leave the keywords blank to browse. Advanced settings contains matching, sorting, page size, search budget, caller overrides and full JSON editing. Reopening the dialog retains the current persona’s conditions and results. Switching personas initializes a new context.

Caller identity comes from the current persona or a Route’s configured primary Agent and is recorded as request metadata. Persona scope controls the separate `agent` parameter. Enter a missing primary Agent session ID in Advanced settings. Requests use the page owner’s authenticated Manager connection.

Results show highlighted terms, source, type, persona and available timestamps. Expand text, read actual details, or copy API URLs and call handles. Adjacent messages with identical titles can expand into all original records. Load more retains the submitted parameters and identity. After changing conditions, run a new search. Waiting, failed and cancelled queries keep the previous successful results visible with their submitted conditions.

Source status shows completion and failure reasons. Requests and responses retains each page’s actual parameters, caller headers, HTTP status, duration, request ID and full response, including the latest failed receipt.

## Interpret results

`capabilities` describes declared sources; `coverage`, `degraded`, and `notQueried` describe actual coverage and gaps. `facets` counts only the current page. A failed source does not discard results from healthy sources. An empty result only describes the covered scope.

Each result supplies `origin`, `detailUrl`, `handle`, and evidence fields. Source evidence determines `state`, `confidence`, and `userConfirmed`; a match does not make an unknown fact confirmed. `observedAt` is the original observation, `retrievedAt` is this read, and `updatedAt` is the record modification time. Read the original detail or active contract through `handle` before acting.

Search reuses the owner indexes and device service without creating a new authoritative copy. Ranked message search reads the full-text candidate set once, avoiding repeated full-text lookups for each document in write order. Ordinary message timelines retain write-order queries. Sources share the request deadline and cancellation signal. Large datasets, one-item pages, and multiple sources add work; choose a suitable page size and measure performance in the actual environment.

If an older version lacks this entry, use the known role with [plan and memory summary search](knowledge-search_en.md) and [message search indexing](message-history-search_en.md); if those are unavailable, record the error and continue with ordinary search. See the [search skill](../skills/rabi-knowledge-search/SKILL.md) for the workflow.
