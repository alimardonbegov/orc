import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutosave } from "./useAutosave";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (save = vi.fn(async () => undefined), valid?: (next: string) => boolean) =>
  ({ save, ...renderHook(({ value }) => useAutosave({ value, save, delay: 100, valid }), { initialProps: { value: "a" } }) });

it("saves after a pause in typing, once", async () => {
  const { result, save } = setup();
  act(() => result.current.change("ab"));
  act(() => result.current.change("abc"));
  expect(save).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(100));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("abc");
});

it("flush saves at once and does nothing when there is nothing new", async () => {
  const { result, save } = setup();
  act(() => void result.current.flush());
  expect(save).not.toHaveBeenCalled();
  act(() => result.current.change("b"));
  await act(async () => result.current.flush());
  await act(async () => vi.advanceTimersByTime(200));
  expect(save).toHaveBeenCalledTimes(1);
});

it("closing the card saves what was typed", () => {
  const { result, save, unmount } = setup();
  act(() => result.current.change("typed"));
  unmount();
  expect(save).toHaveBeenCalledWith("typed");
});

it("a new value from outside does not replace text the person is typing", () => {
  const { result, rerender } = setup();
  act(() => result.current.change("mine"));
  rerender({ value: "theirs" });
  expect(result.current.draft).toBe("mine");
});

it("a new value from outside reaches a field with nothing of its own", () => {
  const { result, rerender } = setup();
  rerender({ value: "theirs" });
  expect(result.current.draft).toBe("theirs");
});

it("a late answer from before the save does not bring the old text back", async () => {
  let finish = () => {};
  const save = vi.fn(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
  const { result, rerender } = setup(save);
  act(() => result.current.change("new"));
  act(() => void result.current.flush());
  rerender({ value: "older" });
  expect(result.current.draft).toBe("new");
  await act(async () => finish());
});

it("a failed save keeps the text and tries again on the next flush", async () => {
  const save = vi.fn(async (): Promise<undefined> => { throw new Error("down"); });
  const { result } = setup(save);
  act(() => result.current.change("text"));
  await act(async () => result.current.flush());
  expect(result.current.draft).toBe("text");
  await act(async () => result.current.flush());
  expect(save).toHaveBeenCalledTimes(2);
});

it("an invalid value is not saved, and revert takes it back", async () => {
  const save = vi.fn(async () => undefined);
  const { result } = setup(save, (next) => next.trim() !== "");
  act(() => result.current.change("   "));
  await act(async () => result.current.flush());
  expect(save).not.toHaveBeenCalled();
  act(() => result.current.revert());
  expect(result.current.draft).toBe("a");
});

it("flush waits for a save already on its way, even with nothing new to send", async () => {
  let finish = () => {};
  const save = vi.fn(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
  const { result } = setup(save);
  act(() => result.current.change("new"));
  act(() => void result.current.flush());
  let done = false;
  act(() => void result.current.flush().then(() => { done = true; }));
  await act(async () => { await Promise.resolve(); });
  expect(save).toHaveBeenCalledTimes(1);
  expect(done).toBe(false);
  await act(async () => finish());
  expect(done).toBe(true);
});
