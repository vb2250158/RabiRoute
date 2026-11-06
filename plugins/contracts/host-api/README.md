# RabiRoute 宿主 API

[English](README_en.md)

插件使用 `@rabiroute/host-api/<moduleId>` 导入共享宿主拥有者的公开接口。此包包含声明与运行时导出签名，使用插件 SDK builder 构建；它不包含或复制宿主状态。

运行时由宿主通过 `prepareModules` 和 `module(moduleId)` 提供原来的共享模块。缺失模块按具体插件依赖报告。后台 worker 是独立进程，不能直接使用主进程宿主端口。

宿主维护者用 `scripts/generate-plugin-host-api.mjs` 从已编译的声明与实际源码导出生成此包。插件作者构建时仅需要此包和 `@rabiroute/plugin-sdk`，无需宿主 TypeScript 源码。
