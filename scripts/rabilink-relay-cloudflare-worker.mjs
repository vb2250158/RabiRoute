const DEFAULT_UPSTREAM = "https://rabi.example.com";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-RabiLink-Token,User-Agent",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

function isOpenApiPath(pathname) {
  return (
    pathname === "/rokid/rabilink/openapi.json" ||
    pathname === "/rokid/rabilink/openapi.manual-auth.json" ||
    pathname === "/openapi/rokid-rabilink-plugin.json" ||
    pathname === "/openapi/rokid-rabilink-plugin.manual-auth.json"
  );
}

function buildUpstreamUrl(requestUrl, upstreamBase) {
  const request = new URL(requestUrl);
  const upstream = new URL(upstreamBase);
  upstream.pathname = request.pathname;
  upstream.search = request.search;
  return upstream;
}

function buildForwardHeaders(request, env) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.set("x-forwarded-host", new URL(request.url).host);
  headers.set("x-forwarded-proto", new URL(request.url).protocol.replace(":", ""));

  if (env.RABILINK_FORWARD_TOKEN && !headers.has("x-rabilink-token")) {
    headers.set("x-rabilink-token", env.RABILINK_FORWARD_TOKEN);
  }

  return headers;
}

async function proxyOpenApi(request, env, upstreamBase) {
  const upstreamUrl = buildUpstreamUrl(request.url, upstreamBase);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: "GET",
    headers: buildForwardHeaders(request, env),
  });

  if (!upstreamResponse.ok) {
    return upstreamResponse;
  }

  const document = await upstreamResponse.json();
  document.servers = [
    {
      url: new URL(request.url).origin,
      description: "RabiLink Relay via Cloudflare Worker",
    },
  ];

  return jsonResponse(document, {
    status: upstreamResponse.status,
  });
}

async function proxyRequest(request, env) {
  const requestUrl = new URL(request.url);
  const upstreamBase = env.RABILINK_UPSTREAM || DEFAULT_UPSTREAM;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (requestUrl.pathname === "/" || requestUrl.pathname === "") {
    return jsonResponse({
      ok: true,
      name: "RabiLink Relay Worker",
      upstream: upstreamBase,
      openapi: `${requestUrl.origin}/rokid/rabilink/openapi.json`,
      manualAuthOpenapi: `${requestUrl.origin}/rokid/rabilink/openapi.manual-auth.json`,
    });
  }

  if (isOpenApiPath(requestUrl.pathname)) {
    return proxyOpenApi(request, env, upstreamBase);
  }

  const upstreamUrl = buildUpstreamUrl(request.url, upstreamBase);
  const init = {
    method: request.method,
    headers: buildForwardHeaders(request, env),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const response = await fetch(upstreamUrl, init);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    try {
      return await proxyRequest(request, env);
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 502 },
      );
    }
  },
};
