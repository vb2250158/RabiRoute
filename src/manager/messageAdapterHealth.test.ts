import assert from "node:assert/strict";
import test from "node:test";
import { summarizeIndependentAdapterHealth } from "./messageAdapterHealth.js";

test("QQ stays healthy when personal Weixin independently needs login", () => {
  const summary = summarizeIndependentAdapterHealth({
    adapters: {
      napcat: {
        type: "napcat",
        label: "NapCat / OneBot",
        maturity: "verified",
        installed: true,
        requirements: [{ id: "login", label: "OneBot 登录资料", required: true, ok: true }]
      },
      weixin: {
        type: "weixin",
        label: "个人微信 / Weixin",
        maturity: "experimental",
        installed: true,
        requirements: [
          { id: "route", label: "已配置个人微信消息端", required: true, ok: true },
          { id: "login", label: "手机微信扫码登录", required: true, ok: false }
        ]
      }
    },
    napcatHealth: {
      route: {
        instances: {
          qq: {
            ok: true,
            enabled: true,
            http: { ok: true, online: true, good: true },
            webui: { reachable: false }
          }
        }
      }
    }
  });

  assert.equal(summary.adapters.napcat.state, "healthy");
  assert.equal(summary.adapters.weixin.state, "needs_login");
  assert.equal(summary.overall.state, "degraded");
  assert.match(summary.adapters.napcat.message, /OneBot/);
  assert.doesNotMatch(summary.overall.message, /全局离线|QQ 离线/);
});

test("reachable NapCat WebUI never counts as usable OneBot by itself", () => {
  const summary = summarizeIndependentAdapterHealth({
    adapters: {
      napcat: {
        type: "napcat",
        label: "NapCat / OneBot",
        maturity: "verified",
        installed: true
      }
    },
    napcatHealth: {
      route: {
        instances: {
          qq: {
            ok: false,
            enabled: true,
            state: "manual-login",
            http: { ok: false },
            webui: { reachable: true }
          }
        }
      }
    }
  });

  assert.equal(summary.adapters.napcat.state, "needs_login");
  assert.match(summary.adapters.napcat.message, /WebUI.*不代表.*OneBot/);
});

test("one healthy QQ and one unhealthy QQ produce a degraded QQ adapter, not global offline", () => {
  const summary = summarizeIndependentAdapterHealth({
    adapters: {
      napcat: {
        type: "napcat",
        label: "NapCat / OneBot",
        maturity: "verified",
        installed: true
      }
    },
    napcatHealth: {
      route: {
        instances: {
          healthy: { ok: true, enabled: true, http: { ok: true } },
          offline: { ok: false, enabled: true, state: "unreachable", http: { ok: false } }
        }
      }
    }
  });

  assert.equal(summary.adapters.napcat.state, "degraded");
  assert.equal(summary.adapters.napcat.available, 1);
  assert.equal(summary.adapters.napcat.total, 2);
  assert.equal(summary.overall.state, "degraded");
});
