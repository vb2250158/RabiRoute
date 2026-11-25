English | [简体中文](agent-search-architecture.md)

# Unified agent search

`GET /api/search` brings together plans and memories, messages, identity relations, conversation situations, screen captures, role Skills, registered operations and available devices. Active operation contracts declare these sources. Each result links to its original read or execution operation.

## Find a remote computer

In **RabiLink → Home → Authorized devices**, select the tag icon on a device card to edit its alias and tags. The alias becomes the card title. The original name remains in advanced information. The current Manager saves the labels by RabiLink application and device identity.

For work on another computer, start with the Rabi CLI using `--operation manager.search --query '{"scope":"devices","q":"device name or tag"}'`. The same source participates in default and role-scoped search. Use the result's `handle.deviceId` and device detail to identify the target, then follow the related terminal or desktop operations. On an older Manager, use the CLI to read the authorized device directory if the `devices` scope is unavailable.


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

Keep filters and page size unchanged across pages. A change in Manager identity, role scope, or the original source snapshot expires the cursor; restart from the first page on 409. Message appends preserve the initial committed prefix, as described below. `expand` is not implemented. `scripts/lib/query-rabi-search.mjs` shares one caller budget across discovery, identity checks, the request, and response reading. It reserves 20% of the remaining budget, capped at 500 milliseconds, for response delivery and body reading so a slow source can expire while other results and coverage gaps still reach the caller.

## Test from the page

On a persona’s Message history page, select Search API test beside All-day recording. Choose a caller identity and persona scope, enter keywords and select a source, then search. Leave the keywords blank to browse. Advanced settings contains matching, sorting, page size, search budget, caller overrides and full JSON editing. Reopening the dialog retains the current persona’s conditions and results. Switching personas initializes a new context.

Caller identity comes from the current persona or a Route’s configured primary Agent and is recorded as request metadata. Persona scope controls the separate `agent` parameter. Enter a missing primary Agent session ID in Advanced settings. Requests use the page owner’s authenticated Manager connection.

Results show highlighted terms, source, type, persona and available timestamps. Expand text, read actual details, or copy API URLs and call handles. Adjacent messages with identical titles can expand into all original records. Scroll near the bottom to load the next page automatically, or select Load more results to continue or retry. Pagination keeps the submitted parameters and identity. After changing conditions, run a new search. Waiting, failed and cancelled queries keep the previous successful results visible with their submitted conditions.

Source status shows completion and failure reasons. Requests and responses retains each page’s actual parameters, caller headers, HTTP status, duration, request ID and full response, including the latest failed receipt.

## Interpret results

`capabilities` describes declared sources. `coverage.notQueried` lists requested sources that could not be queried and sets the overall state to `partial`. `coverage.excluded` reports sources filtered out by adapter or kind. `facets` counts only the current page. A failed source preserves results from healthy sources.

The timeline in a persona’s Message history combines message endpoints, role history and saved captures. The `messages` source matches endpoint message bodies, senders and targets, and searches Agent deliveries, role panel messages, task replies and AIUI exchanges in the role ledger. The role ledger read covers up to 100 recent entries and reports a gap when older records remain. An `adapter` filter selects endpoint messages. `includeArchives` selects endpoint message archives.

`identities` covers saved participants, endpoint accounts, relationship cards and voice identities for the selected personas. `scenarios` covers retained conversation situations. `events` matches saved timeline captures by title, description and capture device and links to the original image.

Each result supplies `origin`, `detailUrl`, `handle`, and evidence fields. Source evidence determines `state`, `confidence`, and `userConfirmed`; a match does not make an unknown fact confirmed. `observedAt` is the original observation, `retrievedAt` is this read, and `updatedAt` is the record modification time. Read the original detail or active contract through `handle` before acting.

Search reuses the owner indexes and device service without creating a new authoritative copy. Ranked message search reads the full-text candidate set once, avoiding repeated full-text lookups for each document in write order. Ordinary message timelines retain write-order queries. Sources share the request deadline and cancellation signal. Large datasets, one-item pages, and multiple sources add work; choose a suitable page size and measure performance in the actual environment.

If an older version lacks this entry, use the known role with [plan and memory summary search](knowledge-search_en.md) and [message search indexing](message-history-search_en.md); if those are unavailable, record the error and continue with ordinary search. See the [search skill](../skills/rabi-knowledge-search/SKILL.md) for the workflow.

## Plugin data sources and role Skills

Operation discovery extracts the plugin's `ApiOperationDefinition.discovery`. Unified search and the dedicated operation catalog share fields, tokenization and ranking. New plugins require no host business-keyword table.

To search its own records, a plugin declares `contract.searchable` with `scope`, `legend` and `kinds` on its original read operation and supplies `searchLanes({request, roles})`. Each lane reads `items`, `version`, `complete` and optional `gaps` from its original owner. Its `read` receives the request cancellation signal and deadline. The host discovers active readers, isolates source failures and retires and drains readers with their operation. Metadata without a reader reports a coverage gap.

The `skills` source reads the original role Skill catalog, matching names, summaries and keywords. Results contain the role, skillId, detail URL and `manager.personas.skills.detail` contract. Full content is read on demand, without running Skill scripts. All hosts use the same search protocol. DSH or another persona integration may reuse identical loaded content; this does not disable search or change how other hosts retrieve catalog entries and content.

Endpoint message continuation retains the original committed append prefix. Newly appended messages appear after refresh without shifting the current query's pages. Changes to the role message window, original prefix, archive layout, Manager or role scope require a fresh query.
