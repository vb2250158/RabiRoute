import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// 测试宿主持有有限 ref；生产后台 timer 保持 unref，超时必须让测试失败。
export async function withTestDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Test operation exceeded ${timeoutMs}ms deadline.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 硬期限只在父进程生效，不给子进程增加任何 ref keeper；未完成的顶层 await 也不能算成功。
export function runIsolatedDeadlineProbe(source: string): void {
  const result = spawnSync(process.execPath, [
    "--import", "./scripts/test-manager-runtime-env.mjs",
    "--import", "tsx", "--input-type=module", "--eval", source
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "deadline-probe-complete");
}
