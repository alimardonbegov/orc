import { useCallback, useEffect, useRef, useState } from "react";

/** Comparison by serialization: task lists arrive identical dozens of times in a row. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Periodically calls fn and keeps the last result. An error does not erase the data.
 *
 * Two rules that interface responsiveness depends on:
 *
 *  1. If the response matches the previous one, the state is not updated at all. Otherwise every
 *     five seconds the task array reference changed and the whole board re-rendered,
 *     even when nothing was happening on the server — that is what made the interface "heavy".
 *  2. While the tab is hidden, polling does not run. On returning to the tab the data
 *     is refreshed immediately, without waiting for the next tick.
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Version counter: if a newer request started while this one was in flight, this result is stale and discarded entirely.
  const versionRef = useRef(0);
  // The latest values are also kept in a ref: comparison must happen BEFORE setState. React drops a setState
  // call with the same value, but it may render the component once more before that —
  // and we need exactly zero extra re-renders on "response unchanged".
  const dataRef = useRef<T | null>(null);
  const errorRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++versionRef.current;
    try {
      const result = await fnRef.current();
      if (version !== versionRef.current) return;
      if (!same(dataRef.current, result)) {
        dataRef.current = result;
        setData(result);
      }
      if (errorRef.current !== null) {
        errorRef.current = null;
        setError(null);
      }
    } catch (e) {
      if (version !== versionRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      if (errorRef.current !== message) {
        errorRef.current = message;
        setError(message);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id === null) id = setInterval(() => void refresh(), intervalMs);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        void refresh();
        start();
      }
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, ...deps]);

  return { data, error, refresh };
}
