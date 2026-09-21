[English](plan-events_en.md) | [简体中文](plan-events.md)

# Plan events and on-demand loading

The plan page initially reads eight summaries. Click **Load more** to read at most 50 additional summaries per request. Scrolling mounts cards already fetched; it does not traverse every page. Manager owns counts and cursors. Displayed records are not a claim that every plan has been loaded.

The `ready` event from `GET /api/events` triggers reconciliation after connection. `plan_changed` invalidates a cached view; it is not authoritative plan data. The page filters by persona and coalesces events for 300 ms, allowing one running refresh and one pending marker. Events wait for active pagination to finish rather than starting a competing page request.

Each event refresh reads only the first eight summaries, retains the new `nextCursor`, and replaces the list after success with a first-page notice. A focused plan refresh reads only that plan. This implementation does not preserve a deep-page position; existing plan-ID-based state still holds form drafts. One notification never walks an entire 100,000-record directory.

Hiding, leaving, or switching persona or filters cancels current requests. The caller's AbortSignal reaches fetch through the client without cancelling other requests. Request version, persona, and filter checks also reject late responses. Returning restores the subscription; connection `ready` or an existing pending marker triggers bounded reconciliation.

Failure retains previous records and offers retry, without an automatic retry loop. An unknown count appears as “—”, not zero or successful emptiness. Only a successful zero-record response permits an empty-result state.

Tests: `ribiwebgui/tests/bounded-plan-refresh.test.ts` covers coalescing, cancellation, queueing and client signal propagation; `knowledge-pagination.test.ts` checks page bounds; `knowledge-load-failure.test.ts` checks failure state. These are not deployed-browser acceptance evidence. The integrated version still needs a build and live-page verification.
