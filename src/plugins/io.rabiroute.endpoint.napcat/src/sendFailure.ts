import { NapCatRequestError, napcatFailureAdvice, type NapCatFailureCode } from "@rabiroute/host-api/shared/napcatDeliveryError";

type LoginObservation = { state?: string; needsUserAction?: boolean; webui?: { loginInfoReadState?: string } };

/** Enrich the original error only. This function never retries a platform operation. */
export async function diagnoseNapcatSendFailure<T>(send: () => Promise<T>, observeLogin: () => Promise<LoginObservation | undefined>): Promise<T> {
  try { return await send(); }
  catch (error) {
    if (!(error instanceof NapCatRequestError)) throw error;
    const diagnostic = error.diagnostic;
    let code: NapCatFailureCode = "NAPCAT_DELIVERY_FAILED";
    let platformResult: "unknown" | "not_sent" | "rejected" = "unknown";
    if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) {
      code = "NAPCAT_AUTHENTICATION_FAILED";
      platformResult = "not_sent";
    } else if (diagnostic.kind === "rejected" && /(?:没有权限|无权限|权限不足|not authorized|permission denied|insufficient permission)/i.test(error.message)) {
      code = "QQ_PERMISSION_DENIED";
      platformResult = "rejected";
    } else if (diagnostic.kind === "transport") {
      code = "NAPCAT_CONNECTION_FAILED";
      // These failures precede the HTTP request. A timeout may follow acceptance.
      if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(diagnostic.transportCode ?? "")) {
        platformResult = "not_sent";
        let observation: LoginObservation | undefined;
        try { observation = await observeLogin(); } catch { /* Preserve the original connection failure. */ }
        if (observation?.state === "qr-login-required" && observation.needsUserAction === true
          && observation.webui?.loginInfoReadState === "observed") {
          code = "NAPCAT_LOGIN_REQUIRED";
        }
      }
    }
    Object.assign(diagnostic, napcatFailureAdvice(code), { platformResult });
    throw error;
  }
}
