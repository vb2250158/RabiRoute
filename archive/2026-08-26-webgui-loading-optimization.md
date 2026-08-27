# WebGUI loading optimization record

English | [简体中文](2026-08-26-webgui-loading-optimization_zh.md)

**Status:** completed
**Scope:** RibiWebGUI startup and the direct route `#/routes/XinghaiBuilder-main/knowledge`.

## Observed problem

The page can remain blank long enough for Lighthouse to report an LCP of 162.49 seconds and DOMContentLoaded of 45.89 seconds. The failure path includes an asynchronous component timeout after 12 seconds.

The knowledge page already loads plans and memories progressively. The blocking work happens earlier:

1. `main.ts` waits for the plugin catalog and every active Web Bundle before mounting Vue.
2. `gatewayStore.load()` makes full gateway configuration, metadata, and network options part of the first knowledge-page data path.
3. The Manager can be saturated by large message-processing-board persistence and plan-catalog refresh work.
4. One watcher is registered for every plan directory, and frontend performance uploads can overlap when the Manager is slow.

## Design constraints

- The Manager remains the authority for route configuration, plugin catalog, role binding, plan data, and runtime state.
- The WebGUI shell, route-loading state, and route-error recovery must not require successful activation of every optional Web Bundle.
- Page-specific code must remain lazily loaded; background plugin refresh must not delay the current route.
- External delivery and other non-reversible side effects retain their existing confirmation and Outbox semantics.
- Existing progressive knowledge-page pagination and rendering windows remain intact.

## Implemented changes

1. `main.ts` mounts the WebGUI shell after LAN address normalization, then refreshes the plugin catalog and optional Web Bundles in the background.
2. `builtinStartupPages.ts` registers `route.knowledge` before the catalog is available. The Manager base bundle no longer registers that route a second time, and the router does not redirect this built-in page to recovery while the catalog is pending or unavailable.
3. `gatewayStore.loadRouteSummaries()` reads `/gateways?summary=1` and projects only Route identity, configuration name, role ID, and running state. The knowledge page resolves its `agentRoleId` from the direct URL summary first; full Gateway configuration, metadata, and network options continue in the background for editor and diagnostics use.
4. Plan cache invalidation now uses one recursive watcher at each role `plans/` root. Unknown-path events serve the warm cache while a debounced full refresh reconciles the catalog. Filesystems without recursive watching retain the 500 ms TTL path.
5. Frontend telemetry has one in-flight upload. Failed submissions restore captured samples and apply exponential backoff before the next attempt.
6. The permanent Chinese and English architecture documents describe these ownership and startup rules. This implementation record remains archived.
7. The message-processing board now uses v2. Unfinished requirements remain for at most 24 hours; `sent`, `not_required`, and `send_failed`, including plan notifications, retain only a 15-minute window. Expiration removes message bodies, attachments, and `replyContext`, leaving only a SHA-256 replay-dedupe key for at most seven days. A matching replay returns `replay_suppressed` without an Agent delivery or board event. Plan subscriptions independently retain the source and worker needed for follow-up notifications, so they no longer keep expired requirements alive.
8. The knowledge page restores its first-paint-first, background-complete plan directory load: it shows eight summaries first, then serially fetches the remaining pages for the same filter until `nextCursor` is empty. It yields one render frame between pages; a Route change, hidden page, or unmount invalidates the request version and stops later requests. Plan bodies, attachments, and card mounting remain bounded by reading position and the scrolling window.

## Verification

- `npx tsc -p tsconfig.json --noEmit` passed.
- `npm exec vue-tsc -- -p ribiwebgui/tsconfig.json --noEmit` passed.
- Focused unit suite passed: 51 tests across startup-route registration, plugin pages/modules, base-bundle registration, and role-knowledge cache behavior.
- `npm run webgui:build` passed and refreshed the Manager base Web Bundle. Vite reported its existing large-chunk warning only.
- The focused message-processing board, Manager route, and forwarding suite passed 58 tests; `npx tsc -p tsconfig.json --noEmit` passed.
- A Chrome DevTools smoke check opened `http://192.168.0.57:8793/#/routes/XinghaiBuilder-main/knowledge` from the current source build. After 14 seconds it showed the fixed shell and the `XinghaiBuilder` knowledge page, never entered plugin recovery, and recorded no page JavaScript errors. Before the Manager restart, the existing process still timed out the plan-data request after 12 seconds; the page stayed rendered and reported that request failure instead of returning to a blank screen.

## Live deployment validation

On August 26, 2026, the Manager was rebuilt and restarted from `dist/manager.js`. The second deployment ran as Manager PID `12560`. The message-processing board was written as v2 and measured 512,833 B with 30 requirements, 13 plan subscriptions, and 166 hash-only dedupe records; the latest persistence write took 46 ms. Twenty concurrent control-plane rounds all succeeded: `/` P95 was 9.3 ms, `/meta` 17.8 ms, `/gateways?summary=1` 29.9 ms, and the knowledge-plan endpoint 62.3 ms. Chrome with a fresh browser profile opened the live direct knowledge page in 320.3 ms to DOMContentLoaded, showed `XinghaiBuilder` and the initial 8 of 419 plans, did not enter recovery, and reported no Console, runtime, or network errors.

## August 26, 2026 follow-up verification

- All nine checks in `node --import tsx --test ribiwebgui/tests/knowledge-pagination.test.ts` passed. They cover automatic continuation after the first page, stopping later requests after a Route change, and stopping when the cursor does not advance.
- `npm run build` passed and regenerated and synchronized the Manager base Web Bundle.
- The prior Manager `12560` exited. The Manager started from the current `dist/manager.js` runs as PID `64660`; `/meta` reports `healthy`. The root HTML is `no-store` and references the current `app-DZNwyrXb.js` entry.
- A fresh Chrome profile opened the direct knowledge page and displayed `XinghaiBuilder`, `计划 419 / 419`, and the loaded-list status with no Console errors. Plan cards remain scroll-windowed, while plan bodies and attachments remain reading-position loaded.
- All 20 concurrent plan-summary requests returned 200. P50 was 148.9 ms, P95 was 162.1 ms, and the maximum was 163.2 ms.
