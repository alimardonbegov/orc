import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialUiState, useUiState } from "./useUiState";

const KEY = "orc.ui.v1";

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("UI state survives a restart", () => {
  it("the selected project and the open task are read from storage at startup", () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: 7, openTaskId: 42, sidebarCollapsed: true }));
    const { result } = renderHook(() => useUiState());
    expect(result.current.ui.projectId).toBe(7);
    expect(result.current.ui.openTaskId).toBe(42);
    expect(result.current.ui.sidebarCollapsed).toBe(true);
  });

  it("the project choice goes to storage at once: the next launch will open the same one", () => {
    const { result } = renderHook(() => useUiState());
    act(() => result.current.setUi({ projectId: 3 }));
    expect(JSON.parse(localStorage.getItem(KEY)!).projectId).toBe(3);
    // This is exactly what "restart" checks: a fresh read of the startup state.
    expect(initialUiState().projectId).toBe(3);
  });

  it("the open task goes into the page address so the link can be shared", () => {
    const { result } = renderHook(() => useUiState());
    act(() => result.current.setUi({ projectId: 2, openTaskId: 11 }));
    expect(location.hash).toBe("#p=2&t=11");
  });

  it("the page address takes precedence over storage: the link opens its own task, not the previous one", () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: 1, openTaskId: 5 }));
    history.replaceState(null, "", "/#p=9&t=99");
    const { result } = renderHook(() => useUiState());
    expect(result.current.ui.projectId).toBe(9);
    expect(result.current.ui.openTaskId).toBe(99);
  });

  it("broken storage does not prevent the app from opening", () => {
    localStorage.setItem(KEY, "{this is not json");
    const { result } = renderHook(() => useUiState());
    expect(result.current.ui.projectId).toBeNull();
    expect(result.current.ui.theme).toBe("system");
  });

  it("the order of the \"Done\" column survives a restart", () => {
    const { result } = renderHook(() => useUiState());
    expect(result.current.ui.doneSort).toBe("recent");
    act(() => result.current.setUi({ doneSort: "oldest" }));
    expect(initialUiState().doneSort).toBe("oldest");
  });

  it("an unknown order from storage is replaced with the default value", () => {
    localStorage.setItem(KEY, JSON.stringify({ doneSort: "alphabetical" }));
    expect(initialUiState().doneSort).toBe("recent");
  });

  it("the dashboard stack split survives a restart, an unfamiliar one is replaced with the default", () => {
    localStorage.setItem(KEY, JSON.stringify({ dashSplit: "by_project" }));
    expect(initialUiState().dashSplit).toBe("by_project");
    localStorage.setItem(KEY, JSON.stringify({ dashSplit: "by eye color" }));
    expect(initialUiState().dashSplit).toBe("by_model");
    // the split by status from the previous version of the screen is no longer offered
    localStorage.setItem(KEY, JSON.stringify({ dashSplit: "by_status" }));
    expect(initialUiState().dashSplit).toBe("by_model");
  });

  it("the chart measure and the breakdown dimension survive a restart, unfamiliar ones are replaced with the default", () => {
    expect(initialUiState().dashMetric).toBe("cost_usd");
    expect(initialUiState().dashBreakdown).toBe("models");
    localStorage.setItem(KEY, JSON.stringify({ dashMetric: "tokens", dashBreakdown: "projects" }));
    expect(initialUiState().dashMetric).toBe("tokens");
    expect(initialUiState().dashBreakdown).toBe("projects");
    localStorage.setItem(KEY, JSON.stringify({ dashMetric: "rubles", dashBreakdown: "by weather" }));
    expect(initialUiState().dashMetric).toBe("cost_usd");
    expect(initialUiState().dashBreakdown).toBe("models");
  });

  it("garbage in the saved values is discarded, not sent into requests", () => {
    localStorage.setItem(KEY, JSON.stringify({ projectId: "abc", openTaskId: 1.5, theme: "pink" }));
    const { result } = renderHook(() => useUiState());
    expect(result.current.ui.projectId).toBeNull();
    expect(result.current.ui.openTaskId).toBeNull();
    expect(result.current.ui.theme).toBe("system");
  });

  it("the theme is applied to the document and saved", () => {
    const { result } = renderHook(() => useUiState());
    act(() => result.current.setUi({ theme: "light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(initialUiState().theme).toBe("light");
    // "System" removes the attribute: prefers-color-scheme decides from there.
    act(() => result.current.setUi({ theme: "system" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("the \"back\" button closes the open task, not drops out of the app", () => {
    const { result } = renderHook(() => useUiState());
    act(() => result.current.setUi({ projectId: 2 }));
    act(() => result.current.setUi({ openTaskId: 11 }));
    // pushState added a history entry; simulate going back to it.
    act(() => {
      history.replaceState(null, "", "/#p=2");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.ui.openTaskId).toBeNull();
    expect(result.current.ui.projectId).toBe(2);
  });
});
