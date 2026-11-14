export type RecordingArtifact = Readonly<{
  artifactId: string;
  ownerRoleId: string;
  mediaKind: "video/mp4";
  occurredAt: string;
  byteLength: number;
  durationMs?: number;
}>;
type ManagerIdentity = Readonly<{ applicationGenerationId: string; managerInstanceId: string }>;
type LatestRecording = Readonly<{ artifact: RecordingArtifact | null; settingsRevision: string; mediaPath?: string }>;

/** Ephemeral page ownership only; cancelling also invalidates unabortable late responses. */
export function createRecordingRequestScope() {
  let generation = 0;
  let controller: AbortController | undefined;
  const cancel = () => { generation++; controller?.abort(); controller = undefined; };
  return {
    cancel,
    begin() {
      cancel();
      const current = generation;
      const own = controller = new AbortController();
      return { signal: own.signal, isCurrent: () => generation === current && !own.signal.aborted };
    }
  };
}

export function releaseRecordingVideo(video: Pick<HTMLVideoElement, "pause" | "removeAttribute" | "load"> | null): void {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

async function meta(fetcher: typeof fetch, signal: AbortSignal): Promise<ManagerIdentity> {
  const response = await fetcher("/meta", { signal, redirect: "error", headers: { accept: "application/json", "cache-control": "no-cache" } });
  const value = await response.json();
  if (!response.ok || !value || ![value.applicationGenerationId, value.managerInstanceId].every(field => typeof field === "string" && field.trim() === field && field.length > 0)) {
    throw new Error("Manager 连接已变化，请重新打开页面。");
  }
  return { applicationGenerationId: value.applicationGenerationId, managerInstanceId: value.managerInstanceId };
}

export async function readLatestRecording(fetcher: typeof fetch, settingsRevision: string, roleId: string, signal: AbortSignal): Promise<LatestRecording> {
  const before = await meta(fetcher, signal);
  signal.throwIfAborted();
  const response = await fetcher("/api/agent/xiaomi-home/recordings/latest", { signal, redirect: "error", headers: {
    accept: "application/json", "cache-control": "no-cache",
    "x-rabiroute-expected-application-generation-id": before.applicationGenerationId,
    "x-rabiroute-expected-manager-instance-id": before.managerInstanceId
  } });
  const body = await response.json();
  if (!response.ok || body?.code !== 0 || !body.data) throw new Error(body?.error?.message || body?.message || "无法读取最新录像。");
  const value = body.data;
  if (value.settingsRevision !== settingsRevision || typeof value.settingsRevision !== "string" || !/^xiaomi-settings:[a-f0-9]{32}$/.test(value.settingsRevision)) {
    throw new Error("米家设置已变化，请重新加载后打开录像。");
  }
  const after = await meta(fetcher, signal);
  signal.throwIfAborted();
  if (after.applicationGenerationId !== before.applicationGenerationId || after.managerInstanceId !== before.managerInstanceId) throw new Error("Manager 连接已变化，请重新打开页面。");
  if (value.artifact === null) return { artifact: null, settingsRevision };
  const artifact = value.artifact;
  if (!artifact || typeof artifact.artifactId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(artifact.artifactId)
    || artifact.ownerRoleId !== roleId || artifact.mediaKind !== "video/mp4" || typeof artifact.occurredAt !== "string" || !Number.isFinite(Date.parse(artifact.occurredAt))
    || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0
    || (artifact.durationMs !== undefined && (!Number.isFinite(artifact.durationMs) || artifact.durationMs <= 0))) throw new Error("录像元数据无效，请重新检测。");
  const query = new URLSearchParams({ expectedApplicationGenerationId: before.applicationGenerationId, expectedManagerInstanceId: before.managerInstanceId, settingsRevision });
  // Never accept a media URL, local path or token from metadata. The existing
  // Manager resource helper owns authentication when this relative path is used.
  const mediaPath = `/api/agent/xiaomi-home/artifacts/${encodeURIComponent(artifact.artifactId)}/content?${query}`;
  return { artifact: { artifactId: artifact.artifactId, ownerRoleId: roleId, mediaKind: "video/mp4", occurredAt: artifact.occurredAt,
    byteLength: artifact.byteLength, ...(artifact.durationMs !== undefined ? { durationMs: artifact.durationMs } : {}) }, settingsRevision, mediaPath };
}
