/**
 * Tests for the Semaphore used by the suggestion engine to honor the
 * maxConcurrent setting (audit EXT-115).
 */

import { describe, expect, it, vi } from "vitest";
import { Semaphore } from "../extension/src/shared/concurrency";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("runs tasks concurrently up to the limit", async () => {
    const sem = new Semaphore(2);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const order: number[] = [];

    const tasks = gates.map((g, i) =>
      sem.run(async () => {
        order.push(i);
        await g.promise;
        return i;
      }),
    );

    // Give microtasks a chance to start the tasks.
    await vi.waitFor(() => expect(order.length).toBe(2));
    expect(order).toEqual([0, 1]);

    gates[0].resolve();
    await tasks[0];
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2]); // task 2 started after a slot freed
  });

  it("queues tasks beyond the limit in FIFO order", async () => {
    const sem = new Semaphore(1);
    const started: number[] = [];
    const release = deferred<void>();
    const t1 = sem.run(async () => {
      started.push(1);
      await release.promise;
      return 1;
    });
    const t2 = sem.run(async () => {
      started.push(2);
      return 2;
    });
    const t3 = sem.run(async () => {
      started.push(3);
      return 3;
    });
    await vi.waitFor(() => expect(started).toEqual([1]));
    release.resolve();
    await Promise.all([t1, t2, t3]);
    expect(started).toEqual([1, 2, 3]);
  });

  it("releases the slot even when the task throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The slot must be free again — this resolves immediately.
    const result = await sem.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("setLimit raises and lowers the effective concurrency", async () => {
    const sem = new Semaphore(1);
    const started: number[] = [];
    const release = deferred<void>();
    const t1 = sem.run(async () => {
      started.push(1);
      await release.promise;
    });
    await vi.waitFor(() => expect(started).toEqual([1]));

    sem.setLimit(3); // raise — queued tasks may start
    const t2 = sem.run(async () => void started.push(2));
    const t3 = sem.run(async () => void started.push(3));
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));

    release.resolve();
    await t1;
    await t2;
    await t3;

    sem.setLimit(1);
    expect(sem.pendingCount()).toBe(0);
  });

  it("never allows a limit below 1", async () => {
    const sem = new Semaphore(0);
    const result = await sem.run(async () => "ok");
    expect(result).toBe("ok");
    sem.setLimit(-5);
    const r2 = await sem.run(async () => "ok2");
    expect(r2).toBe("ok2");
  });
});
