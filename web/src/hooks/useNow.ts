import { useSyncExternalStore } from "react";

/**
 * A shared "clock" for labels like "2 h ago". One timer for the whole app, not a
 * timer per card: there are hundreds of them on the board, and each would tick on its own.
 *
 * Without the clock a label would freeze: task polling does not redraw the board while the
 * server response has not changed (see usePolling), and "just now" would hang for hours.
 */
const TICK_MS = 30_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // The clock stood still while there were no subscribers: the first value is fresh, not from last time.
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => now;

/** Current time in ms, updated every half minute. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
