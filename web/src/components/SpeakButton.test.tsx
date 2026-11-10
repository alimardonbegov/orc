import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakButton } from "./SpeakButton";
import { stopSpeech } from "../lib/speechPlayer";

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  voice: unknown = null;
  lang = "";
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

function installSynth() {
  const spoken: FakeUtterance[] = [];
  const synth = {
    speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
    cancel: vi.fn(),
    getVoices: () => [],
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return { synth, spoken };
}

afterEach(() => {
  stopSpeech();
  Reflect.deleteProperty(window, "speechSynthesis");
  vi.unstubAllGlobals();
});

describe("SpeakButton", () => {
  it("renders nothing when the browser cannot speak", () => {
    const { container } = render(<SpeakButton text="Hello" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("speaks the prepared text, then stops on a second click", async () => {
    const { synth, spoken } = installSynth();
    render(<SpeakButton text={"## Title\n\nPeriod **2020-2023** in `snake_case`."} />);
    await userEvent.click(screen.getByRole("button"));
    expect(spoken[0]?.text).toBe("Title.");
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button"));
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("moves to the next chunk after the pause", async () => {
    vi.useFakeTimers();
    const { spoken } = installSynth();
    render(<SpeakButton text={"First.\n\nSecond."} />);
    screen.getByRole("button").click();
    expect(spoken).toHaveLength(1);
    spoken[0]!.onend?.();
    await vi.advanceTimersByTimeAsync(700);
    expect(spoken.map((u) => u.text)).toEqual(["First.", "Second."]);
    vi.useRealTimers();
  });
});
