package com.rabi.link.modules.rokid;

/** Kernel PID + start ticks; PID reuse does not identify the old receiver as alive. */
public final class ReceiverProcessIdentity {
    public final int pid;
    public final long started;
    private ReceiverProcessIdentity(int pid, long started) { this.pid = pid; this.started = started; }
    public static ReceiverProcessIdentity parse(String stat) {
        int close = stat.lastIndexOf(')');
        int open = stat.indexOf('(');
        if (open < 1 || close <= open) throw new IllegalArgumentException("Invalid proc identity");
        int pid = Integer.parseInt(stat.substring(0, open).trim());
        String[] fields = stat.substring(close + 1).trim().split("\\s+");
        // Remaining fields begin at field 3 (state); starttime is field 22.
        long started = Long.parseLong(fields[19]);
        if (pid <= 0 || started < 0) throw new IllegalArgumentException("Invalid proc identity");
        return new ReceiverProcessIdentity(pid, started);
    }
    public boolean sameProcess(ReceiverProcessIdentity other) { return pid == other.pid && started == other.started; }
}
