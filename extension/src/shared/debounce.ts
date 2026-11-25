/**
 * Per-key debouncer (shared, dependency-free).
 *
 * Why a dedicated module instead of inline setTimeout juggling:
 * the content script's previous inline implementation had a subtle
 * bug — it called clearTimeout() but left the stored timer id in
 * place, then used a truthy-id check ("already scheduled?") that saw
 * the stale id and silently skipped EVERY future re-schedule. Inline
 * analysis therefore died after the first burst of keystrokes and the
 * extension appeared to "not show grammar issues while writing".
 *
 * Contract:
 *  - schedule(key, run): (re)start the timer for `key`. Calling it
 *    again before the timer fires cancels the pending run and starts
 *    a fresh one. The stored id is ALWAYS cleared together with the
 *    timer, so re-scheduling is never skipped.
 *  - cancel(key): drop the pending run for `key` (no-op if none).
 *  - dispose(): cancel every key (used on teardown).
 *
 * The delay is read through a function so callers can honor a live
 * user setting (debounceMs) without re-creating the debouncer.
 */

export interface PerKeyDebouncer {
  schedule(key: string, run: () => void): void;
  cancel(key: string): void;
  dispose(): void;
}

export function createPerKeyDebouncer(delayMs: () => number): PerKeyDebouncer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(key: string, run: () => void): void {
      const prev = timers.get(key);
      if (prev !== undefined) {
        clearTimeout(prev);
        timers.delete(key);
      }
      const delay = Math.max(0, delayMs());
      const timer = setTimeout(() => {
        timers.delete(key);
        run();
      }, delay);
      timers.set(key, timer);
    },
    cancel(key: string): void {
      const t = timers.get(key);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(key);
      }
    },
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
