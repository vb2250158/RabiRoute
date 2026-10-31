<!-- docs-language-switch -->
<div align="center">
English | <a href="./development-hot-reload.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute development hot reload

Development feedback and release acceptance are separate:

- WebGUI uses Vite HMR at `http://127.0.0.1:8793/`.
- RabiSpeech can explicitly use Uvicorn reload. Stop the installed service on port `8781` first.
- Manager is excluded from the safe reload loop. It owns Route child processes, so restarting it would bounce NapCat, RabiLink, personal-Weixin, and persona sessions and may invalidate source-session tokens.
- Native Android code is not covered by this reload loop and still requires a new APK build.
- After a feature is ready, run matching tests and the full build. Activate it according to the [source patch](source-hot-patches_en.md) or [Web patch](web-hot-patches_en.md) support matrix. Full packaging is for installer delivery or a necessary lifecycle switch.

Common commands:

```powershell
# WebGUI only; safe default
npm run dev:hot

# WebGUI plus RabiSpeech; stop the installed service on 8781 first
npm run dev:hot:speech

# RabiSpeech only
npm run speech:dev

# Manager only in a manually isolated data directory and port
npm run manager:dev:isolated
```

`npm run dev:hot -- --check` checks the required ports without starting services. The safe launcher rejects `--manager` so long-lived message adapters cannot accidentally enter a file-watch restart loop.

## Isolated builds for one plugin

Use the existing builder with a separate candidate directory:

```powershell
node scripts/build-plugin-packages.mjs --package io.rabiroute.manager.route-control --output-directory ../route-control-candidate
```

Repeat `--package` to select more packages from the current build profile. Targeted builds preserve unrelated output packages, omit the complete desktop profile, and do not resolve runtime dependencies. SDK types are generated in staging without modifying source files. With no arguments, the builder still processes the full profile.

`build-evidence.json` records the staged inputs, artifact hashes, tool versions, and stage timings. It is build evidence only, not test-cache eligibility, formal Loader acceptance, or installed activation. Matching tests and the required full build still apply. Each output has one writing task; failure restores the previous output. Activation remains with the existing publishing owner.

## Changes in this source slice

When no performance sink is installed, instrumentation runs the original action without timestamps or timing. Optional sink failures do not change the business result; `performanceOperationStatus()` exposes failure counts. Consumers can initialize a lazy detail factory with `bind(group, level)` and update filtering through `configureFilter()`. Existing `record()` calls remain compatible; details already constructed by callers do not become lazy automatically.

Persona chat history pages summaries and loads long bodies on demand. Its bounded page cache supports continuation in both directions; changing personas cancels old requests. Reconnect catch-up preserves an explicit continuation while new-message refresh remains available. See [message history search](message-history-search_en.md) for indexing, stable ordering and capacity evidence.

These statements describe source and isolated validation. The existing publishing owner must separately verify installed activation.

## Candidate test evidence and publication admission

Run `node scripts/verify-plugin-candidate.mjs --config <local-config.json>`. The tool freezes declared inputs and the built candidate into a temporary directory before executing Node tests. Existing full-build and release requirements remain in force.

```json
{
  "sourceRoot": "../source",
  "candidateRoot": "../candidate",
  "cacheRoot": "../verification-cache",
  "inputs": ["tests/plugin", "packages/shared-contract"],
  "tests": ["tests/plugin/behavior.test.mjs"],
  "deterministic": false,
  "completeInputClosure": false
}
```

Root paths are relative to the configuration file; inputs are relative to sourceRoot. Tests access frozen artifacts through `RABI_PLUGIN_CANDIDATE_ROOT`. Declare all imported source, resources and dependencies in inputs; directory membership is fingerprinted too. Materialize links beforehand. The tool does not borrow workspace node_modules automatically. It runs trusted local Node tests, is not a security sandbox, and does not accept network execution requests.

Enable both declarations only after reviewing that all dependencies are declared and tests do not depend on network, time, randomness, undeclared files, user environment or mutable external capabilities. Other tests still execute normally without reuse. Only successful results are cached, binding inputs, tests, candidate files, the Node executable, verifier code, platform and architecture. Corrupt caches cause execution; cache write failures do not discard real test results. Output retains the last 16 KiB of test diagnostics. Use synthetic data and never print credentials.

The tool checks actual files against build evidence and rejects extra files inside a selected package. Tests that mutate their inputs or candidate cannot create passing evidence. Original publication owners now admit locally configured plugins and source/Web candidates with recorded local provenance by actually invoking this CLI, then checking candidate bytes, identity and baseline again before commit. [Developer candidate verification](developer-candidate-admission_en.md) owns the configuration, eligible origins, failure preservation and cancellation/join contract. Existing releases and legitimate other origins without matching rules retain their original contracts. Formal Loader, resource cleanup, external capabilities and post-activation behavior still require execution.

The receipt retains the verifier's `mode=shadow` marker. It neither means publication-owner integration is missing nor grants publication authority by itself. Impact analysis remains a shadow comparison: execution runs the entire configured `tests` set. Admission uses actual test results and candidate hashes, never treating `selectedTests` as executed evidence. This does not establish incremental coverage for every publication source; the admission document also defines the separate automatic code-revision boundary.
`RABI_PLUGIN_CANDIDATE_ROOT` exposes only the evidenced packages and shared contracts, excluding unrelated output packages and build receipts. Inherited OS/user directory environment participates in the cache fingerprint. Tests that depend on mutable contents in those directories, or on absolute temporary directory names, cannot declare a closed deterministic input set.

### Automatic impact closure in shadow mode

An optional `impact.units` array declares each delivery unit's `id`, owned `inputs` and `tests`. Plugins also declare their `manifest` and actual `bindings` mapping service names to provider unit IDs. The tool parses static imports, re-exports, type references, literal dynamic imports and URL resources from frozen files, combining manifest provides/requires/optional, actual bindings and reverse consumers. `runtimeInputs` declares the complete runtime file-read closure; `dynamicInputs` declares the dynamic-loading/discovery closure. These are reviewed dependency declarations, not bypass switches. Required host services may be declared through `impact.externalServices`; current availability still needs runtime validation.

Without a baseline the first run expands to the full declared test set. Pass the previous `impact.snapshot` as `impact.baseline` for subsequent comparisons. File fingerprints detect additions, deletions and both sides of renames; previous dependency edges remain available when calculating affected consumers. Parse errors, unowned inputs, unresolved imports and undeclared dynamic reads report reasons and expand verification. Arbitrary aliases and bare-package resolution are currently unresolved and expand coverage rather than being assumed safe.

`selectedUnits` and `selectedTests` are shadow recommendations. Execution still runs every test in configuration `tests`; `missingCoverage` compares unit-declared tests against that complete execution set. Tests demonstrate that unrelated provider edits do not select independent consumers, but do not establish repository-wide dependency coverage or permission to skip the required full build. Baseline and declaration changes also participate in verification cache keys.
Unsupported source forms including Vue/Svelte/Astro/HTML/MDX and styles explicitly expand verification. Accessing createRequire through node:module, including aliases, requires declared dynamicInputs or also expands coverage. Unsupported syntax is never silently treated as dependency-free.

### Native source and Web artifacts

The same verification configuration accepts explicit `artifactKind: "source-patch"` or `"web-patch"` with `artifactSha256`. For source patches, candidateRoot is the original managed directory and the hash covers the complete bytes of `<hash>.json`. For Web patches, candidateRoot contains the original manifest.json and the hash remains that manifest's complete-byte hash. The default remains plugin-build.

Validation reuses the formal backend build's original `HotPatchCandidateStore` / `verifyWebPatch` owners and their checks, freezing and fingerprinting the owner artifact bytes consumed by this run. Run `npm run build:backend` first; missing owner artifacts report the actual dependency error instead of substituting a weaker schema or plugin proof. Tests see only the artifact closure validated by the original owner through `RABI_CANDIDATE_ROOT`; the plugin environment variable remains compatible. Receipts distinguish artifactKind, the original candidateSha256, a separate inputSha256 and coveredArtifactRoots. Compatibility, current identity/baseline and publication transactions remain the original publication owner's responsibility.
