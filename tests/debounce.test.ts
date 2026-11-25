// @vitest-environment node
/**
 * Regression tests for the per-key debouncer (shared/debounce.ts).
 *
 * These guard the exact bug class that killed inline analysis while
 * writing: the old inline implementation cleared the timeout but kept
 * the stale (truthy) timer id, and a "already scheduled?" check then
 * skipped every future re-schedule — so after one burst of keystrokes
 * the editor was never analyzed again until page reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPerKeyDebouncer } from "../extension/src/shared/debounce";

describe("createPerKeyDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once after the quiet period", () => {
    const d = createPerKeyDebouncer(() => 700);
    const run = vi.fn();
    d.schedule("a", run);
    vi.advanceTimersByTime(699);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("REGRESSION: re-scheduling within the delay replaces the pending run", () => {
    // Old behavior: second schedule() cleared the timer but then a
    // truthy stale-id check aborted the re-schedule → run() never fired.
    const d = createPerKeyDebouncer(() => 700);
    const run = vi.fn();
    d.schedule("a", run);
    vi.advanceTimersByTime(400);
    d.schedule("a", run); // second keystroke inside the debounce window
    vi.advanceTimersByTime(700);
    expect(run).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("REGRESSION: analysis still fires after many rapid re-schedules", () => {
    // Simulates continuous typing: every keystroke re-schedules.
    const d = createPerKeyDebouncer(() => 700);
    const run = vi.fn();
    for (let i = 0; i < 25; i++) {
      d.schedule("a", run);
      vi.advanceTimersByTime(120); // each keystroke < delay
    }
    vi.advanceTimersByTime(700);
    expect(run).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("keeps different keys independent", () => {
    const d = createPerKeyDebouncer(() => 500);
    const a = vi.fn();
    const b = vi.fn();
    d.schedule("editor-1", a);
    d.schedule("editor-2", b);
    vi.advanceTimersByTime(200);
    d.schedule("editor-1", a); // typing in editor 1 must not affect editor 2
    vi.advanceTimersByTime(300); // t=500 → editor-2 fires
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300); // t=800 → editor-1 fires (500ms after re-schedule)
    expect(a).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("cancel() drops the pending run; schedule() after cancel works", () => {
    const d = createPerKeyDebouncer(() => 300);
    const run = vi.fn();
    d.schedule("a", run);
    d.cancel("a");
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    // The critical follow-up: scheduling again MUST work (the old bug
    // permanently blocked this path).
    d.schedule("a", run);
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("cancel() on an unknown key is a no-op", () => {
    const d = createPerKeyDebouncer(() => 300);
    expect(() => d.cancel("nope")).not.toThrow();
    d.dispose();
  });

  it("dispose() cancels every pending run", () => {
    const d = createPerKeyDebouncer(() => 300);
    const a = vi.fn();
    const b = vi.fn();
    d.schedule("x", a);
    d.schedule("y", b);
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("reads the delay on every schedule call (live debounceMs setting)", () => {
    let delay = 100;
    const d = createPerKeyDebouncer(() => delay);
    const run = vi.fn();
    d.schedule("a", run);
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1); // first schedule used 100ms
    delay = 900; // user changed the setting
    d.schedule("a", run); // next schedule must pick up the new delay
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1); // not yet — pending timer uses 900ms
    vi.advanceTimersByTime(800);
    expect(run).toHaveBeenCalledTimes(2); // fired 900ms after the re-schedule
    d.dispose();
  });
});
