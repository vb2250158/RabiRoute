# WebGUI endpoint scope audit

English | [简体中文](webgui-coverage-contract.md)

`npm run check` retains `Audit-WebguiCoverage.mjs`. The audit checks explicit endpoint/method/owner/mode/classification contracts. It neither requires glasses to duplicate every PC management screen nor claims the former 35 missing entries were implemented.

- `required`: existing legacy configuration retains both page implementation and actual Relay method permission requirements.
- `unsupported`: PC-only hooks, LAN Agents, login controls, Xiaomi, desktop pets/settings, processing board, performance, plugins, cache, video, access management and unimplemented role records/documents remain denied by generic forwarding.
- `dedicated`: device profiles, knowledge calls and owner grants use authenticated dedicated routes. Plan statuses map to `plan_statuses`, not generic role API access.
- `pc-helper`: role Skill request helpers have a stable manifest; PC browsing does not prove glasses Skill execution.
- `dynamic-prefix`: peer and dynamic gateway actions are not complete endpoints or wildcard grants. Supported gateway actions are individually required.

Balanced template scanning handles nested expressions and quotes; query suffixes no longer become paths. Unknown discoveries fail closed. Dynamic suffixes retain `:dynamic`. Literal fetch scanning is supplemented by checked helper manifests, not full TypeScript data-flow analysis; new indirect helpers require explicit registration.

The audit extracts and executes the actual current `mobileWebguiPathAllowed(method,path)` for GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, rather than searching the whole Relay file for pathname text. Dedicated endpoints must remain generically denied. Contracts link existing profile HTTP, knowledge E2E and grant HTTP fixtures; checking fixture existence does not replace executing those tests.

Run `node --test scripts/webgui-coverage.test.mjs` for positive cases and rejection of unknown endpoints or sensitive permission widening. The local snapshot audit and four tests passed. No Relay permissions, model ownership, layout, installation or device state were changed. Manifest methods define explicit permission boundaries; a default fetch GET is not evidence of server support.
