import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, LANGUAGES } from "../../i18n";
import { HelpPages } from "./HelpPages";
import { DemoPlayer } from "./DemoPlayer";
import { RichText } from "./RichText";

const LANGUAGE_KEY = "orc.language.v1";

function renderPages(page: "about" | "guide", props: Partial<React.ComponentProps<typeof HelpPages>> = {}) {
  return render(
    <LanguageProvider>
      <HelpPages page={page} onPage={vi.fn()} onClose={vi.fn()} onAddProject={vi.fn()} {...props} />
    </LanguageProvider>,
  );
}

describe("help pages", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  // t() returns the key path itself if the string is in neither the language nor English. The page
  // keys are assembled from lists in the components (FEATURES, SECTIONS…), so a typo
  // in a key is caught not by the compiler but by this test, on every page and every language.
  describe.each(LANGUAGES.map((l) => l.code))("language %s", (code) => {
    beforeEach(() => localStorage.setItem(LANGUAGE_KEY, code));

    it.each(["about", "guide"] as const)("page %s does not show raw dictionary keys", (page) => {
      const { container } = renderPages(page);
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/pages\.[a-z]/);
      expect(text).not.toMatch(/\b(labels|taskModal|projectDialog|taskForm|sidebar|topBar)\.[a-zA-Z]/);
    });
  });

  it("\"About\" talks about limitations, risks and plans", () => {
    renderPages("about");
    expect(screen.getByRole("heading", { name: "Current limitations" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Accepted risks" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What's next" })).toBeInTheDocument();
  });

  it("the \"How it works\" button on the first screen switches to the help", async () => {
    const onPage = vi.fn();
    renderPages("about", { onPage });
    await userEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(onPage).toHaveBeenCalledWith("guide");
  });

  it("the switcher at the top changes the page, \"Back to board\" closes the help", async () => {
    const onPage = vi.fn();
    const onClose = vi.fn();
    renderPages("guide", { onPage, onClose });
    await userEvent.click(screen.getByRole("radio", { name: "About orc" }));
    expect(onPage).toHaveBeenCalledWith("about");
    await userEvent.click(screen.getByRole("button", { name: "Back to board" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("the help table of contents lists all sections", () => {
    renderPages("guide");
    const toc = screen.getByRole("navigation", { name: "Contents" });
    const items = within(toc).getAllByRole("button");
    expect(items).toHaveLength(11);
    expect(items[0]).toHaveTextContent("Before you start");
    expect(items.at(-1)).toHaveTextContent("Hotkeys");
  });

  it("the Russian help uses the labels of the interface itself", () => {
    localStorage.setItem(LANGUAGE_KEY, "ru");
    renderPages("guide");
    expect(screen.getByRole("heading", { name: "Как это работает", level: 1 })).toBeInTheDocument();
    // The field label from the real task form: the help refers to the same words
    expect(document.body.textContent).toContain("«Задание агенту»");
  });
});

describe("DemoPlayer: mini clip", () => {
  afterEach(() => vi.useRealTimers());

  const caps = ["first", "second", "third"];

  it("does not play on its own, goes through all frames on the button and stops on the last one", async () => {
    vi.useFakeTimers();
    render(
      <DemoPlayer title="demo" captions={caps} stepMs={1000}>
        {(step) => <p data-testid="scene">frame {step}</p>}
      </DemoPlayer>,
    );
    expect(screen.getByTestId("scene")).toHaveTextContent("frame 0");
    act(() => vi.advanceTimersByTime(5000));
    // Nothing moved without a press: animations in the panel respond to a person's action
    expect(screen.getByTestId("scene")).toHaveTextContent("frame 0");

    act(() => screen.getByRole("button", { name: "Play" }).click());
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("scene")).toHaveTextContent("frame 1");
    expect(screen.getByText("second")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByTestId("scene")).toHaveTextContent("frame 2");
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("scene")).toHaveTextContent("frame 2");
    expect(screen.getByRole("button", { name: "Replay" })).toBeInTheDocument();
  });

  it("the dots at the bottom rewind to the right frame and pause the clip", async () => {
    render(
      <DemoPlayer title="demo" captions={caps}>
        {(step) => <p data-testid="scene">frame {step}</p>}
      </DemoPlayer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Step 3" }));
    expect(screen.getByTestId("scene")).toHaveTextContent("frame 2");
    expect(screen.getByRole("button", { name: "Step 3" })).toHaveAttribute("aria-current", "step");
  });
});

describe("RichText", () => {
  it("draws `code` in backticks as monospace", () => {
    const { container } = render(<RichText text="run `make test` and wait" />);
    expect(container.querySelector("code")).toHaveTextContent("make test");
    expect(container.textContent).toBe("run make test and wait");
  });
});
