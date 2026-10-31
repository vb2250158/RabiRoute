<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.message-adapter-control

This built-in Manager plugin uses the original scan service and message-adapter probes through `host.manager.message-adapter-control@1`, and provides `manager.message-adapter-control@1`. Page and navigation entries remain plugin contributions.

`createMessageAdapterControlOperations` installs `GET /api/scan/message-adapters` from the same executable contract, with operation ID `manager.message-adapters.scan`. Results include adapters, independent health, scan diagnostics, NapCat instance observations and the original gateway summary. Optional `gatewayId` is returned as request metadata and does not filter probes. The first repeated value wins; an empty value means absent. Unknown query fields and request bodies remain ignored.

Scanning reuses the native provider registry, parallel bounded scans and health summarizer. A timeout is not evidence that an adapter is offline or logged out. The operation does not install adapters, change configuration, launch processes, log in or repair anything. Authenticated remote connections use the same public contract and existing explicit user disables, without another per-adapter permission layer.

Native probes may read local material, inspect processes or contact configured endpoints. The scan deadline bounds response waiting only. Actual adapter and NapCat probes share the service tracking set. Retirement stops admission, joins registered operations and real probes, then unregisters providers. HTTP 200 and scan observations do not prove physical-device, login or messaging acceptance.
