# Contributing to RabiRoute

RabiRoute is a connection layer. Every message input and every agent backend is its own plugin, so adding one is a complete contribution on its own — you do not need to understand the whole router to add a piece.

That is also the fastest way in: pick a platform you already use, add it as a plugin, and let the shared router, plans, memory and delivery ledger do the rest.

## Ways to contribute

| Contribution | What it takes | Start here |
| --- | --- | --- |
| Add a message input | Familiarity with one platform SDK | `src/plugins/io.rabiroute.endpoint.*` |
| Add an agent backend | That agent's IPC, CLI or HTTP interface | `docs/agent-adapter-standard-requirements_en.md` |
| Fix a bug | Reproducing it and reading logs | Open an issue first |
| Improve the WebGUI | Vue 3 and TypeScript | `ribiwebgui/` |
| Write or translate docs | Clear writing | `docs/` |

## Get a working build

Node.js 22.13 or newer.

If you only want to run the app, use the packaged build described in [getting started](docs/getting-started_en.md). Building from source on Windows also needs the .NET 9 SDK.

```bash
npm install
npm run build
npm run start:manager
```

The Manager prints the address it bound to. The WebGUI is served from that address.

## Tests

Run the suites that cover what you touched, not the whole matrix every time.

```bash
npm test              # backend and shared contracts
npm run webgui:build  # WebGUI build
npm run check:config  # configuration text checks
```

`npm test` pins `--test-concurrency=2` because several suites share one manager runtime environment. Raising it produces failures that have nothing to do with your change.

## Code conventions

- TypeScript in strict mode. No `any` in new public contracts.
- A new platform becomes its own package under `src/plugins/<plugin-id>/`. Do not add a name to a central factory and route the real work through an existing plugin — the plugin boundary is what keeps one broken adapter from taking down the others.
- Declare only capabilities you have actually verified. A declared-but-unaccepted capability becomes a panel that always fails for the user.
- Keep Chinese and English docs in step. A behaviour change without its translated page counts as unfinished.

## Pull requests

- One concern per pull request.
- Describe what you observed, why it happens, and what you changed. The observation matters more than the diff.
- State how you verified it: the command, the test name, the page you opened.
- Include a screenshot for any WebGUI change.

## Adding a platform

Read [the agent adapter standard](docs/agent-adapter-standard-requirements_en.md) before writing code. It defines the plugin contract, the capability declaration rules and what must be accepted before a platform may be called verified.

Two kinds of platform exist and they are not interchangeable:

- **Message inputs** receive from a chat platform and hand normalised events to the router.
- **Agent backends** deliver a routed message into an agent task and carry the result back.

A minimal platform package carries `rabi.plugin.json`, `agent-adapter.json` and the Manager, Gateway and Web entry points for that platform. A reusable walkthrough lives in `skills/create-rabiroute-agent-adapter/`.

## What not to do

- Never commit credentials, tokens, session cookies or private workspace paths.
- Do not describe an experimental path as verified, and do not claim a capability you have not exercised.
- Do not keep a compatibility branch for a caller that no longer exists. Remove it and record the change in the changelog.

## Ask

Open an issue. If the question concerns one platform, say which platform and what you already tried — that turns a vague report into something reproducible.
