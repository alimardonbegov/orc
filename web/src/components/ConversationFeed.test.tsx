import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NO_EXTRAS } from "../activity";
import type { ActivityEvent } from "../types";
import { ConversationFeed } from "./ConversationFeed";

vi.mock("../api", () => ({ api: {} }));

const text = (id: string, body: string): ActivityEvent => ({ id, session: 1, offset: 0, at: "2026-11-06T10:00:00Z", kind: "text", text: body, truncated: false });

/** A scroll root with the numbers a browser would give it: jsdom lays nothing out. */
function fakeRoot(height = 2000, client = 500) {
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { get: () => height });
  Object.defineProperty(el, "clientHeight", { get: () => client });
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => { top = v; } });
  return el;
}

const feed = (root: HTMLElement, events: ActivityEvent[], startAtEnd: boolean) => (
  <ConversationFeed
    source={{ kind: "task", id: 7 }}
    events={events}
    extras={NO_EXTRAS}
    now={null}
    loaded
    earlier={null}
    loadingEarlier={false}
    onLoadEarlier={() => {}}
    scrollRoot={root}
    startAtEnd={startAtEnd}
  />
);

it("a card opens on the task: new rows do not pull the reader down until they reach the end themselves", () => {
  const root = fakeRoot();
  const { rerender } = render(feed(root, [text("a", "first")], false));
  expect(root.scrollTop).toBe(0);
  rerender(feed(root, [text("a", "first"), text("b", "second")], false));
  expect(root.scrollTop).toBe(0);
  // The reader scrolls to the end: from now on the live end is followed
  act(() => {
    root.scrollTop = 1500;
    root.dispatchEvent(new Event("scroll"));
  });
  rerender(feed(root, [text("a", "first"), text("b", "second"), text("c", "third")], false));
  expect(root.scrollTop).toBe(2000);
  expect(screen.getByText("third")).toBeInTheDocument();
});

it("opened to answer, the thread starts at its end", () => {
  const root = fakeRoot();
  render(feed(root, [text("a", "first")], true));
  expect(root.scrollTop).toBe(2000);
});
