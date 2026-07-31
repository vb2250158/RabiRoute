import {
  WEIXIN_SESSION_TIMEOUT_ERRCODE,
  WeixinHttpError,
  weixinApiError,
  type WeixinOpenClawState
} from "../weixinOpenClaw.js";

export type WeixinSessionPhase =
  | "never_logged_in"
  | "restoring"
  | "restored"
  | "temporarily_unreachable"
  | "invalid";

export type WeixinSessionStatus = {
  phase: WeixinSessionPhase;
  loggedIn: boolean;
  credentialsRetained: boolean;
  loginRequired: boolean;
  error?: string;
};

export function describeWeixinStartup(state: WeixinOpenClawState): WeixinSessionStatus {
  if (state.token) {
    return {
      phase: "restoring",
      loggedIn: false,
      credentialsRetained: true,
      loginRequired: false
    };
  }
  if (state.authState === "recoverable" || state.credentialsRetained) {
    return {
      phase: "temporarily_unreachable",
      loggedIn: false,
      credentialsRetained: true,
      loginRequired: false,
      error: state.storageError
    };
  }
  return {
    phase: state.authState === "invalid" ? "invalid" : "never_logged_in",
    loggedIn: false,
    credentialsRetained: false,
    loginRequired: true
  };
}

export function applyWeixinPollSuccess(
  state: WeixinOpenClawState,
  now = new Date()
): { state: WeixinOpenClawState; status: WeixinSessionStatus } {
  const nextState: WeixinOpenClawState = {
    ...state,
    authState: "recoverable",
    credentialsRetained: true,
    lastConfirmedAt: now.toISOString(),
    invalidatedAt: undefined
  };
  return {
    state: nextState,
    status: {
      phase: "restored",
      loggedIn: true,
      credentialsRetained: true,
      loginRequired: false
    }
  };
}

function isExplicitSessionInvalidation(error: unknown): error is Record<string, unknown> {
  if (error instanceof WeixinHttpError) return error.status === 401 || error.status === 403;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const payload = error as Record<string, unknown>;
  const httpStatus = Number(payload.status || 0);
  return httpStatus === 401
    || httpStatus === 403
    || Number(payload.errcode || payload.ret || 0) === WEIXIN_SESSION_TIMEOUT_ERRCODE;
}

export function applyWeixinPollFailure(
  state: WeixinOpenClawState,
  error: unknown,
  now = new Date()
): { state: WeixinOpenClawState; status: WeixinSessionStatus } {
  if (isExplicitSessionInvalidation(error)) {
    return {
      state: {
        baseUrl: state.baseUrl,
        contextTokens: {},
        authState: "invalid",
        credentialsRetained: false,
        invalidatedAt: now.toISOString(),
        updatedAt: now.toISOString()
      },
      status: {
        phase: "invalid",
        loggedIn: false,
        credentialsRetained: false,
        loginRequired: true,
        error: error instanceof Error ? error.message : weixinApiError(error)
      }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    state: {
      ...state,
      authState: state.token ? "recoverable" : state.authState,
      credentialsRetained: Boolean(state.token || state.credentialsRetained)
    },
    status: {
      phase: "temporarily_unreachable",
      loggedIn: false,
      credentialsRetained: Boolean(state.token || state.credentialsRetained),
      loginRequired: false,
      error: message
    }
  };
}
