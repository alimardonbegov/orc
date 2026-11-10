import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SidebarSection } from "./SidebarSection";

it("is closed by default, says so to assistive tech, and opens on a click", async () => {
  render(
    <SidebarSection title="Details" count={3}>
      <p>inside</p>
    </SidebarSection>,
  );
  const toggle = screen.getByRole("button", { name: /Details/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("inside").parentElement).toHaveAttribute("hidden");
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("inside").parentElement).not.toHaveAttribute("hidden");
  expect(toggle).toHaveTextContent("3");
});

it("can start open, and the actions sit beside the toggle rather than inside it", async () => {
  const onAction = vi.fn();
  render(
    <SidebarSection title="Usage" defaultOpen actions={<button onClick={onAction}>Add</button>}>
      <p>inside</p>
    </SidebarSection>,
  );
  expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(onAction).toHaveBeenCalled();
  // the click on the action did not toggle the section
  expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-expanded", "true");
});

it("a controlled section follows its owner", async () => {
  const onOpenChange = vi.fn();
  render(
    <SidebarSection title="Log" open={false} onOpenChange={onOpenChange}>
      <p>inside</p>
    </SidebarSection>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Log" }));
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(screen.getByRole("button", { name: "Log" })).toHaveAttribute("aria-expanded", "false");
});
