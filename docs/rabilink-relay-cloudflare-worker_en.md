<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-relay-cloudflare-worker.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Cloudflare Worker Proxy for RabiLink Relay

> Status: environment-specific operations workaround. Use it only when the Relay's IP endpoint works, the client requires a domain, and an unfiled domain is blocked by the hosting/DNS environment. It is not a core RabiLink protocol dependency.

## Purpose

Some mainland-hosted IP endpoints remain reachable while requests with an unfiled hostname are redirected to a provider block page. Public wildcard-IP domains may be blocked the same way. A Cloudflare `workers.dev` hostname can proxy the working upstream IP/domain for clients such as Rizon that require a domain-form URL.

Files:

```text
scripts/rabilink-relay-cloudflare-worker.mjs
wrangler.rabilink-relay.toml
scripts/Test-RabiLinkRelayWorker.ps1
```

The Worker is a transparent proxy, not a path allowlist. Except for the root helper page and OpenAPI server-URL rewrite, it preserves method, query, body, and authentication headers.

Important proxied groups include:

```text
/health
/rokid/rabilink/openapi*.json
/rokid/rabilink/input
/rokid/rabilink/messages
/rokid/rabilink/tasks/*
/worker/tasks/*
/worker/messages
/api/rabilink/mobile/*
/api/rabilink/devices/*
```

CORS preflight allows `GET`, `POST`, and `PATCH` plus `Authorization` and `X-RabiLink-Token`. Do not strip those headers in another reverse-proxy layer.

## Deploy

```powershell
cd <repo>
npx wrangler deploy --config .\wrangler.rabilink-relay.toml
```

or:

```powershell
npm run relay:rabilink:worker:deploy
```

Run the local proxy/contract checks first:

```powershell
npm run relay:rabilink:worker:check
```

To override the upstream:

```powershell
npx wrangler secret put RABILINK_UPSTREAM
```

Store only the upstream URL. Do not put a RabiLink application token in the Worker. Each client/application supplies its own token so one Worker can serve several accounts and applications without becoming a shared-credential proxy.

## Rizon/OpenAPI import

Prefer:

```text
https://<worker>.workers.dev/rokid/rabilink/openapi.json
```

If built-in OpenAPI authentication is incompatible, use the manual-auth document and configure:

```text
Header: X-RabiLink-Token
Value: <application token>
```

For a reusable/public template, use the agent-token document so the token is supplied by the individual Agent/tool parameters rather than embedded in plugin-level authentication.

The Worker rewrites `servers[0].url` to its own hostname so imported tools do not fall back to the blocked upstream hostname/IP.

## Verify

```powershell
Invoke-RestMethod https://<worker>.workers.dev/health
Invoke-RestMethod https://<worker>.workers.dev/rokid/rabilink/openapi.json
```

Full checks:

```powershell
.\scripts\Test-RabiLinkRelayWorker.ps1 `
  -WorkerBaseUrl https://<worker>.workers.dev `
  -SkipQueueSmoke
```

With an application token, omit `-SkipQueueSmoke` to test authenticated compatibility tasks, task-free proactive messages, idempotent `deliveryId`, and global stream consumption.

Worker success does not replace AIUI acceptance. Before release, separately verify record-first `/rokid/rabilink/input` and empty-cursor recovery from `/rokid/rabilink/messages?stream=1`.
