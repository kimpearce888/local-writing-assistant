/**
 * Minimal concurrency limiter (semaphore) used by the suggestion engine
 * to honor the `maxConcurrent` setting: at most N analyses run against
 * the native host at once; additional requests queue in FIFO order.
 *
 * Pure async utility — no chrome.* dependency — so it is unit-testable.
 */
export class Semaphore {
  private max: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max) || 1);
  }

  /** Update the limit. Already-acquired slots are not revoked; the new
   *  limit applies to future acquire() calls. */
  setLimit(max: number): void {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.drain();
  }

  /** Run `fn` when a slot is free, releasing the slot afterwards. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Outstanding (queued + active) request count. */
  pendingCount(): number {
    return this.active + this.queue.length;
  }

  private async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.max && this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}
