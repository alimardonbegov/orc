import "@testing-library/jest-dom/vitest";

/* jsdom does not implement some browser APIs that Radix relies on (popover positioning)
   and our components. Without stubs it is the environment that fails, not the logic. */

const g = globalThis as Record<string, unknown>;

if (typeof g.ResizeObserver === "undefined") {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof g.DOMRect === "undefined") {
  g.DOMRect = class {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {
      return {};
    }
  };
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/* localStorage. In this environment Node's experimental storage ends up on window,
   started without a file (`--localstorage-file was provided without a valid path`):
   the object exists but has no methods. We replace it with a working in-memory version —
   otherwise there is nothing to verify UI state persistence with. */
if (typeof window.localStorage?.setItem !== "function") {
  const makeStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } as Storage;
  };
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, name, { writable: true, configurable: true, value: makeStorage() });
    Object.defineProperty(globalThis, name, { writable: true, configurable: true, value: window[name] });
  }
}

if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
