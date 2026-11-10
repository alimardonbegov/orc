import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** What the server holds. */
  value: string;
  save: (next: string) => Promise<unknown>;
  delay?: number;
  /** A value that must not reach the server (an empty title) stays in the field and is not saved. */
  valid?: (next: string) => boolean;
}

/**
 * A text field that saves itself: after a pause in typing, on leaving the field, and when the field goes
 * away, so closing the card with Escape loses nothing.
 *
 * The field is the source of truth while it holds unsaved text. The card is re-read by a poll and after
 * every save, and a late answer must not put an old value under the person's cursor, so a new value
 * from outside is taken only when the field has nothing of its own and no save is in flight.
 */
export function useAutosave({ value, save, delay = 1500, valid }: Options) {
  const [draft, setDraft] = useState(value);
  const saved = useRef(value);
  const latest = useRef(value);
  const inFlight = useRef(0);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  const validRef = useRef(valid);
  useEffect(() => {
    saveRef.current = save;
    validRef.current = valid;
  });

  useEffect(() => {
    if (value === saved.current || inFlight.current > 0) return;
    const clean = latest.current === saved.current;
    saved.current = value;
    if (clean) {
      latest.current = value;
      setDraft(value);
    }
  }, [value]);

  /** Saves now. The promise settles when the save does and never rejects, so a caller can wait for it. */
  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = latest.current;
    // Nothing new to send, but what was sent may still be on its way, and a caller waits for that too
    if (next === saved.current || validRef.current?.(next) === false) return pending.current;
    const before = saved.current;
    saved.current = next;
    inFlight.current += 1;
    pending.current = saveRef.current(next)
      .then(() => undefined)
      .catch(() => {
        // The text stays in the field and counts as unsaved: the next pause or blur tries again.
        // Reporting the failure is the caller's: it knows where errors are shown.
        if (saved.current === next) saved.current = before;
      })
      .finally(() => {
        inFlight.current -= 1;
      });
    return pending.current;
  }, []);

  const change = useCallback(
    (next: string) => {
      latest.current = next;
      setDraft(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  /** Back to what the server holds: an empty title is not saved, it is taken back. */
  const revert = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    latest.current = saved.current;
    setDraft(saved.current);
  }, []);

  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  return { draft, change, flush, revert };
}
