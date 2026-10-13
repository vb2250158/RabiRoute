/** Serialize sends only within one persona/account/conversation; unrelated chats remain concurrent. */
export class AgentSendConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string | undefined, action: () => Promise<T>): Promise<T> {
    if (!key) return action();
    const previous = this.tails.get(key);
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(key, tail);
    try {
      if (previous) await previous;
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
