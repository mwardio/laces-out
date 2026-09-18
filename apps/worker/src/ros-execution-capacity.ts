/** One builder or two replays per validation process; FIFO avoids starving a waiting builder. */
export class RosExecutionCapacity {
  private used = 0;
  private readonly waiting: {
    units: number;
    signal: AbortSignal;
    resolve: () => void;
    reject: (reason: unknown) => void;
    abort: () => void;
  }[] = [];

  private drain(): void {
    while (this.waiting.length > 0) {
      const first = this.waiting[0]!;
      if (this.used + first.units > 2) return;
      this.waiting.shift();
      first.signal.removeEventListener("abort", first.abort);
      this.used += first.units;
      first.resolve();
    }
  }

  async run<T>(units: 1 | 2, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const item = {
        units,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(item);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("ROS execution aborted", { cause: signal.reason }),
          );
          this.drain();
        },
      };
      this.waiting.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
      this.drain();
    });
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      this.used -= units;
      this.drain();
    }
  }
}
