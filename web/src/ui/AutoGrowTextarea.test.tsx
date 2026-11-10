import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { AutoGrowTextarea } from "./Field";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <AutoGrowTextarea aria-label="Text" placeholder="write here" value={value} onChange={(e) => setValue(e.target.value)} />;
}

const mirror = () => document.querySelector("[data-autogrow-mirror]") as HTMLElement;

it("the mirror holds the text with a trailing space, so a final empty line is counted", () => {
  render(<AutoGrowTextarea aria-label="Text" value={"one\ntwo\n"} onChange={() => {}} />);
  expect(mirror().getAttribute("data-autogrow-mirror")).toBe("one\ntwo\n ");
});

it("the mirror follows what is typed, so the field grows with it", async () => {
  render(<Harness />);
  await userEvent.type(screen.getByRole("textbox", { name: "Text" }), "a{Enter}b");
  expect(mirror().getAttribute("data-autogrow-mirror")).toBe("a\nb ");
});

it("an empty field is as tall as its placeholder", () => {
  render(<Harness />);
  expect(mirror().getAttribute("data-autogrow-mirror")).toBe("write here ");
});

it("the field has no scrollbar of its own and cannot be dragged to another size", () => {
  render(<Harness />);
  const area = screen.getByRole("textbox", { name: "Text" });
  expect(area).toHaveClass("overflow-hidden", "resize-none");
  expect(area).toHaveAttribute("rows", "1");
});

it("the mirror is out of the way of the screen reader, the pointer and find-in-page", () => {
  render(<Harness initial="only once" />);
  expect(mirror()).toHaveAttribute("aria-hidden", "true");
  expect(mirror()).toHaveClass("pointer-events-none", "invisible");
  // The text is drawn from an attribute, so the page holds it once, in the field
  expect(screen.getAllByText("only once")).toHaveLength(1);
});

it("the field and its mirror share one box, so the lines wrap in the same places", () => {
  render(<AutoGrowTextarea aria-label="Text" value="x" className="px-1" onChange={() => {}} />);
  const area = screen.getByRole("textbox", { name: "Text" });
  for (const cls of ["px-1", "py-1.5", "text-[13px]", "leading-relaxed", "whitespace-pre-wrap"]) {
    expect(area).toHaveClass(cls);
    expect(mirror()).toHaveClass(cls);
  }
});

it("a minimum height holds both the field and its mirror", () => {
  render(<AutoGrowTextarea aria-label="Text" value="x" minHeight={80} onChange={() => {}} />);
  expect(screen.getByRole("textbox", { name: "Text" })).toHaveStyle({ minHeight: "80px" });
  expect(mirror()).toHaveStyle({ minHeight: "80px" });
});
