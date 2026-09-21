export type VideoProgressJob = {
  status: string;
  createdAt: string;
  startedAt?: string;
  progressStage?: string;
  progressValue?: number | null;
  progressMax?: number | null;
  progressUnit?: string;
};

export function videoProgressPresentation(job: VideoProgressJob, now: number) {
  const running = job.status === "running";
  const measurable = running && Boolean(job.progressStage) && typeof job.progressValue === "number" && Number.isFinite(job.progressValue)
    && job.progressValue >= 0 && typeof job.progressMax === "number" && Number.isFinite(job.progressMax) && job.progressMax > 0;
  const percent = measurable ? Math.round(Math.min(1, job.progressValue! / job.progressMax!) * 100) : null;
  const started = Date.parse(running && job.startedAt ? job.startedAt : job.createdAt);
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const elapsed = `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
  return {
    label: running ? job.progressStage || "正在处理，等待阶段信息" : "等待前面的任务完成",
    percent,
    count: measurable && job.progressUnit ? `${Math.min(job.progressValue!, job.progressMax!)}/${job.progressMax} ${job.progressUnit}` : "",
    elapsed: `${running && job.startedAt ? "已用" : "提交后"} ${elapsed}`,
  };
}
