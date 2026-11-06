# RabiRoute host API

[简体中文](README.md)

Plugins import shared host interfaces through `@rabiroute/host-api/<moduleId>` and build with the plugin SDK builder. This package contains declarations and runtime export signatures. It does not contain or copy host state.

At runtime the host supplies its original shared modules through `prepareModules` and `module(moduleId)`. An unavailable module is reported as a dependency of the affected plugin. Background workers run in separate processes and cannot directly use main-process host ports.

Host maintainers generate this package with `scripts/generate-plugin-host-api.mjs` from compiled declarations and actual source exports. Plugin authors build against this package and `@rabiroute/plugin-sdk` without the host TypeScript source tree.
