import type { SpeechModelManagementSnapshot } from "@shared/speechModelManagement";

type ManagerEnvelope<T> = {
  code: number;
  data?: T;
  message?: string;
};

async function request(pathname: string, init: RequestInit = {}): Promise<SpeechModelManagementSnapshot> {
  const response = await fetch(pathname, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let body: ManagerEnvelope<SpeechModelManagementSnapshot>;
  try {
    body = JSON.parse(text) as ManagerEnvelope<SpeechModelManagementSnapshot>;
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (!response.ok || body.code !== 0 || !body.data) {
    throw new Error(body.message || `HTTP ${response.status}`);
  }
  return body.data;
}

export const speechModelManagementClient = {
  snapshot: (): Promise<SpeechModelManagementSnapshot> => request("/api/speech/model-management"),
  installRuntime: (): Promise<SpeechModelManagementSnapshot> => request(
    "/api/speech/model-management/runtime/install",
    { method: "POST" }
  ),
  installModel: (alias: string): Promise<SpeechModelManagementSnapshot> => request(
    `/api/speech/model-management/models/${encodeURIComponent(alias)}/install`,
    { method: "POST" }
  )
};
