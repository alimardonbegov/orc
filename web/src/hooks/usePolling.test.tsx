import { renderHook, act, waitFor } from "@testing-library/react";
import { vi, it, expect } from "vitest";
import { usePolling } from "./usePolling";

it("loads at once, repeats on the interval and can refresh", async () => {
  vi.useFakeTimers();
  let n = 0;
  const fn = vi.fn(async () => ++n);
  const { result } = renderHook(() => usePolling(fn, 1000));
  await act(async () => {});
  expect(result.current.data).toBe(1);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(result.current.data).toBe(2);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.data).toBe(3);
  vi.useRealTimers();
});

it("an error goes into error, the data stays", async () => {
  let fail = false;
  const fn = vi.fn(async () => { if (fail) throw new Error("boom"); return 7; });
  const { result } = renderHook(() => usePolling(fn, 100000));
  await waitFor(() => expect(result.current.data).toBe(7));
  fail = true;
  await act(async () => { await result.current.refresh(); });
  expect(result.current.error).toBe("boom");
  expect(result.current.data).toBe(7);
});

it("a stale response does not overwrite a fresh one with overlapping calls", async () => {
  vi.useFakeTimers();
  const delays = [50, 10]; // the first call (on mount) answers slower than the second (manual refresh)
  const values = [100, 200];
  let call = 0;
  const fn = vi.fn(() => {
    const i = call++;
    return new Promise<number>((resolve) => {
      setTimeout(() => resolve(values[i]), delays[i]);
    });
  });
  const { result } = renderHook(() => usePolling(fn, 1_000_000));
  // the effect on mount starts the first call (i=0, resolves in 50ms)
  await act(async () => {});
  // while the first is still in flight, we manually start the second (i=1, resolves in 10ms, before the first)
  act(() => { void result.current.refresh(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(result.current.data).toBe(200);
  // the first call now resolves too, but it is stale: it must not overwrite data
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(result.current.data).toBe(200);
  vi.useRealTimers();
});

it("an identical response does not cause a re-render: the board does not twitch every five seconds", async () => {
  vi.useFakeTimers();
  const fn = vi.fn(async () => [{ id: 1, title: "Task" }]);
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return usePolling(fn, 1000);
  });
  await act(async () => {});
  const afterFirst = renders;
  expect(result.current.data).toEqual([{ id: 1, title: "Task" }]);

  // Three passes in a row with the same content: a new array each time, but the state is the same.
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(fn.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(renders).toBe(afterFirst);

  // But a changed response must reach the component.
  fn.mockResolvedValue([{ id: 1, title: "Renamed" }]);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(result.current.data).toEqual([{ id: 1, title: "Renamed" }]);
  vi.useRealTimers();
});

it("a hidden tab does not poll the server, but coming back refreshes the data at once", async () => {
  vi.useFakeTimers();
  const fn = vi.fn(async () => Math.random());
  renderHook(() => usePolling(fn, 1000));
  await act(async () => {});
  const afterMount = fn.mock.calls.length;

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(fn.mock.calls.length).toBe(afterMount);

  visibility.mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(fn.mock.calls.length).toBe(afterMount + 1);

  visibility.mockRestore();
  vi.useRealTimers();
});
