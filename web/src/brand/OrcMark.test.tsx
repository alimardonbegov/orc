import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrcMark } from "./OrcMark";
import { OrcLogo } from "./OrcLogo";

describe("OrcMark", () => {
  it("without a label the mark is decorative and hidden from screen readers", () => {
    const { container } = render(<OrcMark />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).not.toHaveAttribute("role");
  });

  it("with a label the mark becomes an image with a name", () => {
    render(<OrcMark title="orc" />);
    expect(screen.getByRole("img", { name: "orc" })).toBeInTheDocument();
  });

  it("the eyes glow phosphor green only when the dispatcher is alive", () => {
    const { rerender } = render(<OrcMark />);
    const eyes = screen.getByTestId("orc-eyes");
    expect(eyes.getAttribute("class")).toContain("opacity-35");
    expect(eyes.getAttribute("class")).not.toContain("--live");

    rerender(<OrcMark awake />);
    expect(eyes.getAttribute("class")).toContain("fill-[var(--live)]");
    expect(eyes.getAttribute("class")).not.toContain("orc-eyes-pulse");

    rerender(<OrcMark awake working />);
    expect(eyes.getAttribute("class")).toContain("orc-eyes-pulse");
  });

  it("work without a live dispatcher does not light the eyes", () => {
    render(<OrcMark working />);
    const eyes = screen.getByTestId("orc-eyes");
    expect(eyes.getAttribute("class")).not.toContain("orc-eyes-pulse");
    expect(eyes.getAttribute("class")).not.toContain("--live");
  });
});

describe("OrcLogo", () => {
  it("the name is set in lowercase, the mark is labelled", () => {
    render(<OrcLogo tagline="agent control panel" />);
    expect(screen.getByText("orc")).toBeInTheDocument();
    expect(screen.getByText("agent control panel")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "orc" })).toBeInTheDocument();
  });
});
