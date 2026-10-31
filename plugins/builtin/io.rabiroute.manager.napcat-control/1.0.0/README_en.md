<a href="./README.md">简体中文</a> | English

# io.rabiroute.manager.napcat-control

This built-in Manager plugin reuses the original NapCat instance, configuration and process owners through `host.manager.napcat-control@1`, and provides `manager.napcat-control@1`.

Ten POST `/api/message/napcat-*` operations install routes, input contracts and discovery entries from `createNapcatControlOperations`. Their operation IDs are `manager.napcat.<suffix>`: `repair-all`, `ensure-ready`, `health`, `login-panel`, `login-action`, `configure-onebot`, `add`, `launch`, `restart` and `remove`. Authenticated remote connections may invoke these public operations, subject to explicit user disables and the existing object, account and binding checks.

Original permissive JSON input, empty-body `{}` defaults and native coercion remain, without adding an application byte limit. `repair-all` ignores every body. Login panel and action responses use `no-store`. Native `ok` truthiness determines each operation's HTTP status; lifecycle failures retain `400 {ok:false,message,state}`.

There is no request-level idempotency key. Inspect the original instance health and configuration after an uncertain result; do not automatically replay login, repair, add, remove or process actions. HTTP success does not prove QQ login, message delivery or physical-device acceptance.

Candidate preparation only creates a private control context and registers candidate routes. Formal `context.publication` publication synchronously switches the active context and opens operation admission. Preparation failure or synchronous publication failure preserves the previous context, operations and guardian.

Retirement closes admission and joins accepted native actions. It stops the global supervisor only while its own context is still active. After replacement, the old activation's paired supervisor retires independently and cannot stop the new supervisor. Context cleanup also checks reference identity. Bound processes remain with the original process owner across plugin generations; replacing a plugin does not end QQ.

Controlled regressions cover failed candidates, synchronous publication rollback, replacement and revision rollback within one Manager, plus an accepted command's real test-child `close` and stdout/stderr drain. Tests never start QQ/NapCat. Installed-runtime and real-account acceptance remain separate.
