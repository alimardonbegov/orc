import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DescriptionView } from "./DescriptionView";
import { Linkified } from "./Linkified";

describe("Linkified", () => {
  it("renders an address as a short link opening in a new tab", () => {
    render(<Linkified text="Done: https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789." />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://claude.ai/code/artifact/0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent!.length).toBeLessThan(50);
  });

  it("makes links clickable in a message of the conversation", () => {
    render(<DescriptionView text={"Look\n[PR](https://github.com/o/r/pull/7)"} compact />);
    expect(screen.getByRole("link", { name: "PR" })).toHaveAttribute("href", "https://github.com/o/r/pull/7");
  });
});
