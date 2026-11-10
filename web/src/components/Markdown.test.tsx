import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders bold, a list and a table instead of raw symbols", () => {
    const text = "**Where tokens go.** Here:\n\n- one\n- two\n\n| Agent | Mode |\n|---|---|\n| `card-builder` | **Sonnet** |";
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector("strong")?.textContent).toBe("Where tokens go.");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("card-builder").tagName).toBe("CODE");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("|---");
  });

  it("opens links in a new tab and shortens a bare address", () => {
    render(<Markdown text="See https://github.com/o/r/pull/7 and [doc](https://example.com/a)" />);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "https://github.com/o/r/pull/7");
    expect(links[0].textContent).toBe("github.com/o/r/pull/7");
    expect(links[1]).toHaveAttribute("target", "_blank");
    expect(links[1].getAttribute("rel")).toContain("noopener");
  });

  it("does not interpret raw html or javascript links", () => {
    const { container } = render(<Markdown text={'<script>x</script> <b>hi</b> [bad](javascript:alert(1))'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByRole("link")?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });

  it("keeps single line breaks", () => {
    const { container } = render(<Markdown text={"a\nb"} />);
    expect(container.querySelector("br")).not.toBeNull();
  });
});
