# AIUI, phone settings and RabiPC knowledge acceptance matrix

English | [简体中文](aiui-agent-acceptance.md)

Status: historical 0.3.15 implementation and candidate evidence, not current 0.3.22 acceptance or completion of the whole objective. The PC knowledge-permission forms, phone grant editor and external-MCP RabiLink path discussed below are retired. All counts, screenshots, package hashes and remaining-work tables refer to their original source checkpoints; historical “latest” labels are not current releases or instructions. AIUI still owns Agent execution rather than delegating inference to PC.

Since 0.3.22, devices authenticated in the same RabiLink application use the PC’s built-in Manager knowledge tools, including mutations, without another role/tool/write grant or MCP secret. See the [current knowledge runtime](rabilink-knowledge-runtime_en.md), [connection contract](rabilink-peer-tunnel_en.md) and [retired-page migration](user-guide/knowledge-bridge-settings_en.md). New builds, installed Host/static assets and physical-device acceptance require separate evidence; none of the old passes establishes this new path.

## Historical evidence and limits

| Layer | Evidence at the historical checkpoint | Not established |
|---|---|---|
| Root application | Latest full local root build exit 0. Earlier knowledge tests 4 plus original Relay runtime tests 17 total 21; Relay/UI/knowledge set 30/30; dynamic Manager contract 6/6 | Formal installation, refreshed Host and actual loaded browser assets |
| Independent MCP | After shared-schema extraction, 51/51; official SDK HTTP/stdio initialization/catalog checks; 3643 artifact files verified by size and SHA-256 | Real Host only provided identity checks; no actual plan/memory CRUD acceptance |
| Application receipts | Applied means one successful application of a revision, not live health. Actual service/page integration 10 tests passed; final related set 23 passed | Historical success does not prove current connectivity, hardware voice or automatic tool continuation |
| Request-scope audit | Scope contracts and negative tests: 4 passed. The original 35 WebGUI differences were classified without broadening proxy allowlists | Not all PC management features are exposed to glasses; generic forwarding remains restricted |
| PC settings UI | Safe settings, authoritative save readback and actual runtime ready/capabilities are implemented; dedicated tests and latest root build passed | Saved, preflight-ready and actual tool execution remain separate; no formal installation acceptance |
| AIUI tools | Read tools wired into the page; read-result/next-result controls wired and pure tests passed; no fake model continuation | Automatic multi-step continuation and write interaction remain unimplemented; mocks are not real-host evidence |
| Queue | Real Relay/runtime/official MCP HTTP with synthetic business; duplicate-write, restart, lease and revocation tests | No rollback of already executed requests; synthetic business is not real Manager mutation acceptance |
| Phone UI | Agent settings and knowledge grants wired; DOM/HTTP tests cover ownership, receipts and recovery | Real phone layout, touch and keyboard usability |
| HUD / test package | Final report confirms 9 core scripts, four Chinese/ASCII stress cases across two sizes, and normal Ink passed. Safe edges and the central 130px region have zero drawing; injected overflow was rejected. The 93968-byte AIX passed official reader verification of 9 files and matching hashes | Placeholder URL/empty-token package is not a deployment package; full local check passed, but formal installation and hardware acceptance remain pending |

Sources are local build reports, MCP shared-contract validation reports, actual test logs and final branch receipts supplied by the parent. Public documentation contains no machine-specific private paths. Sets overlap and represent different source checkpoints; they must not become a combined whole-goal pass rate. This AIX SHA-256 is `9e1cc828829c74f58a9926f6891f1c0b1c655f690b872e0994d4d1616cc2d4a1`. The ConfigSurface `remoteAgentDefaultDeviceId` baseline mismatch was corrected. Latest full `npm run check` reports `CHECK_EXIT0`, covering 9 core scripts, 11 contract negative tests, endpoint/config/status, Runtime, Ink, both resize checks, AIX and Craft. AIX size and hash remain unchanged. Windows `release0.3.15-e6e3709e82f8` was successfully built in isolation and delivered. New Desktop offscreen/Host contracts, final selftest, per-file ZIP readback, packaged knowledge Runtime imports and 11 Relay modules passed verification. This establishes build/artifact validation, not formal installation or actual Manager startup. The independent MCP service is not included in the root installer. This release evidence applies only to the `release0.3.15-e6e3709e82f8` source checkpoint; subsequent source changes are not automatically included and require a separate build and verification.

| Windows artifact | Size (bytes) | SHA-256 | Status |
|---|---:|---|---|
| ZIP | 335113407 | `f93f3f9572c94a292a28743b5b7038a9589df6ad8e43790289eee86b08cada22` | Built and verified |
| Setup | 332308398 | `6da811c9675943a6522a85c1b868d3427c41d6001de16304ae8d7ed535567ad2` | `NotSigned`, not executed |

## Later finding: frozen package not recommended for production

Actual Chrome validation of the phone knowledge-grant page found that native `fetch` invoked through `env.fetch` had an invalid `this` receiver and threw `TypeError: Illegal invocation`; no HTTP request was sent. Earlier minimal DOM/HTTP tests missed this browser-integration defect. The native fetch wrapper is fixed in shared source; grant inputs are disabled during initial/busy/pending states, with 44px labels and 20px checkboxes. Related tests passed 7/7, exit 0. Actual Chrome at widths 320/390/768 completed profile and grant saves, with GET readback matching revisions 1/2/3 respectively. All six pages had no horizontal overflow and long tool-label center clicks hit their controls. The parent independently inspected the grant screenshot at width 320. These are actual desktop Chrome checks at mobile viewport sizes, not physical-phone acceptance.

Frozen `release0.3.15-e6e3709e82f8` **contains this defect and must not be recommended for production deployment**. It was not installed, so the defect was not deployed to the existing runtime. Sizes, hashes and build checks above remain facts about the old package, not proof of current production readiness. Neither the subsequent fetch fix nor new original-key receipt recovery is included in that frozen package; both require verification and repackaging.

An earlier exclusive regression for new receipt recovery had **43 tests: 42 passed and 1 persist timeout**, with root cause undetermined. Do not call it an all-pass regression. Existing AIUI full `npm run check` success remains valid but does not replace the new Relay/browser/receipt acceptance.

Earlier additional evidence: the parent verified a single regression run against fixed source: **52/52** passed, dynamic Manager contracts **6/6** passed, and hashes of 2017 files remained unchanged. Seven deterministic safe-stage diagnostic tests passed. This is not a root-cause fix for the persist timeout; the original **43/42/1** failure record remains. The standalone source supplement candidate `relay-source-supplement-candidate.zip` has been delivered: 85952 bytes, SHA-256 `a053500243b9dd0d2b3f96829b2160ebe789c9ec0c41d8a54ef8f90c02b41f7f`. Dependency closure and syntax checks passed for 12 modules, with archive roundtrip verification for 16 files. It is not independently runnable and excludes Node, dependencies, WebGUI, OpenAPI and configuration; it does not establish production readiness. The old Setup remains unsuitable for production deployment.

The visual Skill editor and account-switch protection have completed related validation: 18 related tests passed. Actual Chrome at three widths verified add/edit/save and matching GET revisions; invalid input sent zero PUTs and preserved raw content, while late responses after an owner change triggered freezing. The final exclusive regression passed **58/58**, including all earlier 52 tests and 6 new tests; dynamic Manager contracts passed **6/6**, and hashes of 2019 files remained unchanged, with logs checked by the parent. This does not explain or erase the historical persist timeout. The new 13-module source candidate has been delivered: 88017 bytes, SHA-256 `60337e328ec8af421d2fbf454d336f9dd8a55d3ada0a6a55281f44ac071d9fb8`, with 13-module closure and 17-file archive roundtrip checks passed. It is not independently runnable; the old 12-module candidate excludes these Skill changes. The new complete Windows candidate `d1ae4d594048` has finished building and includes these fixes; the known-defect status of old `e6e3709e82f8` remains.

### Historical complete candidate d1ae4d594048 (not installed or production-ready)

Payload SHA-256: `d1ae4d59404853d6b752b91ad40b85450157ffe77682a7c8ca32f38f2ce7ece3`. Hashes matched for 20 files: 13 modules, manifest and 6 documents. Final selftest, ZIP roundtrip, ISCC and packaged imports passed; the parent directly inspected key fixes in the payload. An additional **45 three-party contract tests passed**, not a combined regression total of 103 with the earlier 58.

| New artifact | Size (bytes) | SHA-256 | Status |
|---|---:|---|---|
| ZIP | 335134730 | `590ecaac7feb8fc7e83b48c31ecaf518e19ff188b152976e2f642b86158c4769` | Build/artifact checks passed |
| Setup | 332338601 | `d3922a517ecd140c00785acb9ad255789a69f9d67bef5ed0e4d455a89373f882` | `NotSigned`, not executed |

The new package is not formally installed or production-ready; the historical persist timeout root cause remains undetermined. The independent MCP service is not included in Setup.

Actual payload browser validation passed, exit 0: packaged Node 22.17.1 and Relay used temporary data with Chrome at width 320. Enabled Skills saved with PUT 200/revision 1 and full matching GET content; a `plan_list` grant with writes false also matched GET readback. No console errors or horizontal overflow; Node, manifest and 13 module hashes were unchanged before/after. The parent checked the report. This is not installation, a formal service, or physical-phone acceptance.

### Historical complete candidate 0.3.15-397c589c9e64 (not installed or production-ready)

Earlier d1ae validation remains valid historical evidence but excludes the later visual MCP UI. Latest payload SHA-256: `397c589c9e644fdde7d5c449f1e52ba9db942f4483204b77a0be4fd318ca4cbf`. Source hashes matched for 21 files: 14 modules, manifest and 6 documents. Build, selftest, ZIP roundtrip, ISCC and imports passed.

| Latest artifact | Size (bytes) | SHA-256 | Status |
|---|---:|---|---|
| ZIP | 335137463 | `0da1bed4b1882b56318dc9159474df96cbd811cb469f5d54ac144fb94a04b6a8` | Build/artifact checks passed |
| Setup | 332338489 | `2cdc3ae655c8756a93b564ee46bdd5946559547a5371a1d133d775e9741e8d0f` | `NotSigned`, not installed |

Node 22 joint regression passed **64/64**, cross-end contracts **53/53**; do not add these sets. Dynamic checks first scored **4/6** because the fixture lacked AGENTS; after completing the fixture, only that set was rerun and passed **6/6**. Preserve the initial failure; 2376 input files were unchanged. Actual packaged Node 22/Relay with temporary data and Chrome at width 320 verified visual Skill/MCP enable, label/content edit/save and matching GET, plus grant saves. Invalid MCP JSON sent zero PUTs and preserved raw input; no console errors or overflow. Hashes of 14 modules, Node and manifest were unchanged and all temporary processes were closed. This does not establish formal installation, a running service or physical-phone acceptance. Candidate 397 is not production-ready, the historical persist cause remains undetermined, and MCP service deployment is separate.

Stability evidence: the fixed 14-module source passed 10 sequential independent E2E runs on Node 22, all exit 0. Hashes of 2376 inputs were unchanged, the original five-second timeout was not changed, and logs for every sample were retained. Non-reproduction does not establish a root-cause fix for the historical persist timeout.

Official-contract follow-up: six targeted public fetches reviewed the redirected official repository and model documentation on main/v0.18.x without establishing result submission by callId and continuation. No real host was run; main is not assumed to be a released runtime, and API absence is not asserted. See the [tool contract review](../apps/rabilink-aiui/docs/agent-tool-contract_en.md); single-step boundaries remain.

## Historical remaining work (not current instructions)

| Category | Remaining gap | Acceptance exit | Safe next step / external information |
|---|---|---|---|
| Deployment | Latest complete `397c589c9e64` includes the later MCP UI and fixes and passed artifact checks, but is unsigned, uninstalled and not production-ready; old `e6e3709e82f8` has a known defect | Review candidate risks/target, then installation and actual resource/health checks; deploy MCP separately | Do not install old Setup or equate temporary payload browser tests with formal service acceptance; preserve private configuration |
| Retired deployment path | External MCP and the PC knowledge-permission UI were not formally deployed at that checkpoint; 0.3.22 replaces them with built-in Manager access | Old gaps do not establish new acceptance; actual calls and recovery need new verification | Do not configure the old knowledge URL, secret or permission forms |
| Hardware evidence | Phone save → AIUI persistence → next model → one-time application receipt not device-tested | Matching revision/role/tool binding, offline/restart/ownership/save-failure handling and usable phone UI | Need connected phone/glasses, model, firmware/AIUI version, current app and connection method; no plaintext token request |
| Hardware evidence | ASR/TTS, real tool events and result reading/paging lack real-host evidence | Voice, explicit role choice, read call, cancellation/timeout, no double responses/echo and actual readability | Same hardware information; a host model is not necessarily offline inference |
| Unimplemented | Official tool-result submission and automatic model continuation remain unverified | Official contract or real-host proof, followed by multi-step tests | Continue public/version investigation; ordinary prompts cannot masquerade as tool responses |
| Write feature not wired | New pure policy `utils/knowledge-write-confirmation.js` passed **12/12** pure tests on Node 22, logs verified by the parent: TTL, persist-before-action, single consumption, scope and final-persist race protection. Excluded from AIX/397; glasses still advertise only six read tools | Page, physical confirmation, host CSPRNG, atomic storage, actual receipt validator, HTTP and recovery remain unwired and unverified; a pure module is not a usable write feature | Continue isolated validation under the [write-confirmation plan](../apps/rabilink-aiui/docs/knowledge-write-confirmation-plan_en.md); phone allowWrites is not confirmation of a specific mutation, nor proof of device write capability |
| Unimplemented | Skills are bounded inline guidance; MCP is the fixed `rabi-knowledge` reference, not arbitrary installation | Generic packages/services require provenance, versions, permissions, credential isolation, rollback and actual catalogs | Improve current editing; more JSON fields alone do not safely permit arbitrary execution |
| Unimplemented / longevity | Profile/grant/write-intent and session call ledgers have 128-entry limits; closing tabs may lose sessionStorage recovery | Safe operation beyond limits and recoverable uncertain intent without losing historical deduplication | Controlled lifecycle/segmentation and stress tests; never simply evict keys and replay |
| Configuration concurrency | PC UI uses the existing identity API without configuration revision CAS | Explicit multi-admin conflict protection; refresh must not falsely confirm an uncertain secret update | Add versioned settings contract; keep write-only secrets and current uncertainty guidance |
| Scope | Configuration-command counts do not establish “all Agent capabilities” | Separate user-visible exits for multi-step work, cancellation, memory/context, permissions, recovery and third-party tools | Continue itemized acceptance rather than marking the entire objective complete |

## Historical next steps (superseded where paths were retired)

1. Packaged Chrome saving is verified and the new complete candidate is built. Continue reviewing the historical receipt persist timeout and candidate risks before confirming installation targets, unsigned-package risks and recovery plans. The old package remains unsuitable for production.
2. Validate the full first-success path through the existing safe settings UI; continue specific write confirmation and controlled long-term recovery rather than rebuilding an already implemented UI.
3. Verify devices and installation targets, then complete phone/glasses loops without clearing existing data.
4. Accept official continuation, third-party installation and longevity separately; preserve outstanding boundaries.

The parent ran `devices -l` using locally discovered ADB, exit 0 with an empty list. This proves only that this ADB had no connected devices then, not that glasses are unavailable or unsupported. Hardware connection details await the user. This does not prevent useful source, packaging or simulated-integration work.

## Related contracts

- [Single-step tools](../apps/rabilink-aiui/docs/knowledge-single-step_en.md), [page integration](../apps/rabilink-aiui/docs/knowledge-tool-page_en.md), [one-time application receipts](../apps/rabilink-aiui/docs/agent-profile-runtime_en.md)
- [Retired PC settings migration](user-guide/knowledge-bridge-settings_en.md), [current PC runtime](rabilink-knowledge-runtime_en.md)
- [Retired phone-grant page migration](knowledge-grant-phone-ui_en.md), [profile HTTP](aiui-agent-profile-http_en.md)
- [Official tool contract](../apps/rabilink-aiui/docs/agent-tool-contract_en.md)

The linked migration pages describe removal of the historical permission editors. The runtime page is the authority for current built-in Manager knowledge access.
