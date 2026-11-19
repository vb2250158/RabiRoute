import { onScopeDispose, ref, watch, type ComputedRef } from "vue";
import { browserUuid } from "../browserUuid";
import { userFacingError } from "../userFacingError";
import type { MessageEndpointCardContext } from "./messageEndpointCardContext";

type State = { state: "waiting" | "ready" | "failed" | "cancelled"; qrCodeDataUrl?: string; message?: string };

export function useEndpointQrPairing(
  type: "feishu" | "wecom",
  context: ComputedRef<MessageEndpointCardContext | undefined>,
  configured: () => boolean,
  prepare: (routeId: string) => Promise<void>,
  refresh: () => Promise<void>
) {
  const showingQr = ref(false);
  const qrImage = ref("");
  const error = ref("");
  const ready = ref(false);
  let cancel: (() => void) | undefined;

  function manual(): void {
    cancel?.();
    cancel = undefined;
    showingQr.value = false;
    qrImage.value = "";
    error.value = "";
  }

  async function scan(): Promise<void> {
    manual();
    const routeId = context.value?.routeId;
    if (!routeId) return;
    showingQr.value = true;
    ready.value = false;
    const path = `/api/message/${type}/routes/${encodeURIComponent(routeId)}/qr/${browserUuid()}`;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let headers: Record<string, string> | undefined;
    const disconnect = () => {
      if (headers) void fetch(path, { method: "DELETE", headers }).catch(() => undefined);
    };
    cancel = () => { live = false; clearTimeout(timer); disconnect(); };

    function failed(cause: unknown): void {
      if (!live) return;
      qrImage.value = "";
      error.value = userFacingError(cause);
    }

    async function request(method: "GET" | "POST"): Promise<State> {
      const response = await fetch(path, { method, headers });
      const body = await response.json() as { code: number; data?: State; message?: string };
      if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || "无法获取扫码状态。");
      return body.data;
    }

    async function show(state: State): Promise<void> {
      if (!live) return;
      if (state.state === "ready") {
        try { await refresh(); } finally {
          if (live) { manual(); ready.value = true; }
        }
      } else if (state.state === "waiting") {
        qrImage.value = state.qrCodeDataUrl || "";
        timer = setTimeout(() => { void request("GET").then(show, failed).catch(failed); }, 1600);
      } else {
        failed(state.message || "扫码已结束，请重试。");
      }
    }

    try {
      await prepare(routeId);
      if (!live) return;
      const response = await fetch("/meta");
      const meta = await response.json() as { applicationGenerationId?: string; managerInstanceId?: string };
      if (!response.ok || !meta.applicationGenerationId || !meta.managerInstanceId) throw new Error("暂时无法确认当前服务。");
      if (!live) return;
      headers = {
        "x-rabiroute-expected-application-generation-id": meta.applicationGenerationId,
        "x-rabiroute-expected-manager-instance-id": meta.managerInstanceId
      };
      const result = await request("POST");
      if (live) await show(result);
      else disconnect();
    } catch (cause) { failed(cause); }
  }

  watch(() => context.value?.routeId, () => { manual(); ready.value = false; });
  watch([() => context.value?.active, () => context.value?.loginRequested], ([active, requested]) => {
    if (active && requested && !configured()) void scan();
    else if (!active) manual();
  }, { immediate: true });
  onScopeDispose(manual);
  return { showingQr, qrImage, error, ready, scan, manual };
}
