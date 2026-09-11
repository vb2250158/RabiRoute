export class AutomaticUpdateQueue {
  private running = false;
  private dirty = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private sequence = 0;
  private idle?: Promise<void>;

  constructor(private readonly execute: (sequence: number, isCurrent: () => boolean) => Promise<void>, private readonly onError: (error: unknown) => void, private readonly settleMs = 300) {}

  schedule(): void {
    if (this.closed) return;
    this.sequence++;
    this.dirty = true;
    if (this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.idle = this.run(); }, this.settleMs);
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        const sequence = this.sequence;
        try { await this.execute(sequence, () => !this.closed && sequence === this.sequence); }
        catch (error) { this.onError(error); }
      }
    } finally { this.running = false; }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.idle;
  }
}
