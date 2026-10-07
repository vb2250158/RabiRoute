/** A Node IPC channel ties a Linux Manager to the Host that created it.
 * A lost parent requests normal Manager teardown; systemd KillMode=control-group
 * provides the kernel-enforced boundary for a stalled or forcibly killed app.
 */
export function bindLinuxHostParentLifetime(): void {
  if (process.platform !== "linux" || process.env.RABIROUTE_HOSTED !== "1"
    || process.env.RABIROUTE_HOST_TRANSPORT !== "node-ipc") return;
  if (!process.connected || typeof process.send !== "function") {
    throw new Error("Linux Host-owned Manager requires its live parent IPC channel.");
  }
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
}
