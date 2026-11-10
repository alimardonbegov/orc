import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { DeliverablesSection, formatSize } from "./DeliverablesSection";
import { api } from "../api";
import type { Deliverable, DeliverableVersion, Task } from "../types";

vi.mock("../api", () => ({ api: { taskDeliverables: vi.fn() } }));

const task = { id: 7, updated_at: "t", status: "verifying" } as Task;

function version(over: Partial<DeliverableVersion>): DeliverableVersion {
  return { id: 1, name: "a", version: 1, size: 100, created_at: "", mime: "text/plain; charset=utf-8", inline: true, url: "/api/deliverables/1/file", ...over };
}
function group(over: Partial<DeliverableVersion>, older: Partial<DeliverableVersion>[] = []): Deliverable {
  const latest = version(over);
  return { name: latest.name, latest, versions: [latest, ...older.map((o) => version({ name: latest.name, ...o }))] };
}

beforeEach(() => {
  (api.taskDeliverables as any).mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

it("renders nothing until a file is handed in", async () => {
  (api.taskDeliverables as any).mockResolvedValue([]);
  const { container } = render(<DeliverablesSection task={task} />);
  await waitFor(() => expect(api.taskDeliverables).toHaveBeenCalledWith(7));
  expect(container).toBeEmptyDOMElement();
});

it("stays quiet when the server is older than the page", async () => {
  (api.taskDeliverables as any).mockRejectedValue(new Error("404"));
  const { container } = render(<DeliverablesSection task={task} />);
  await waitFor(() => expect(api.taskDeliverables).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it("lists files with size and a version badge only where there are several", async () => {
  (api.taskDeliverables as any).mockResolvedValue([
    group({ id: 2, name: "report.md", version: 2, size: 2048 }, [{ id: 1, version: 1 }]),
    group({ id: 3, name: "shot.png", mime: "image/png", url: "/api/deliverables/3/file" }),
  ]);
  render(<DeliverablesSection task={task} />);
  expect(await screen.findByRole("button", { name: /report\.md/ })).toHaveTextContent("v2");
  expect(screen.getByRole("button", { name: /shot\.png/ })).not.toHaveTextContent("v1");
  expect(screen.getByRole("button", { name: /report\.md/ })).toHaveTextContent("2.0 KB");
});

it("shows text as text, never as markup", async () => {
  (api.taskDeliverables as any).mockResolvedValue([group({ id: 2, name: "r.txt", url: "/api/deliverables/2/file" })]);
  (fetch as any).mockResolvedValue({ ok: true, text: () => Promise.resolve("<script>alert(1)</script>") });
  render(<DeliverablesSection task={task} />);
  await userEvent.click(await screen.findByRole("button", { name: /r\.txt/ }));
  expect(await screen.findByText("<script>alert(1)</script>")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith("/api/deliverables/2/file?inline=1");
  expect(document.querySelector("script, iframe, object, embed")).toBeNull();
});

it("shows an image through img and an HTML file only as a download, without fetching it", async () => {
  (api.taskDeliverables as any).mockResolvedValue([
    group({ id: 3, name: "shot.png", mime: "image/png", url: "/api/deliverables/3/file" }),
    group({ id: 4, name: "page.html", mime: "application/octet-stream", inline: false, url: "/api/deliverables/4/file" }),
  ]);
  render(<DeliverablesSection task={task} />);
  await userEvent.click(await screen.findByRole("button", { name: /shot\.png/ }));
  expect(await screen.findByAltText("shot.png")).toHaveAttribute("src", "/api/deliverables/3/file?inline=1");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: /page\.html/ }));
  expect(await screen.findByText(/not shown here/)).toBeInTheDocument();
  expect(document.querySelector("iframe")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute("href", "/api/deliverables/4/file");
});

it("switches between versions of a file", async () => {
  (api.taskDeliverables as any).mockResolvedValue([
    group({ id: 6, name: "r.txt", version: 2, url: "/api/deliverables/6/file" }, [{ id: 5, version: 1, url: "/api/deliverables/5/file" }]),
  ]);
  (fetch as any).mockImplementation((url: string) => Promise.resolve({ ok: true, text: () => Promise.resolve(url.includes("/5/") ? "old" : "new") }));
  render(<DeliverablesSection task={task} />);
  await userEvent.click(await screen.findByRole("button", { name: /r\.txt/ }));
  expect(await screen.findByText("new")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "v1" }));
  expect(await screen.findByText("old")).toBeInTheDocument();
});

it("formats sizes", () => {
  expect(formatSize(10)).toBe("10 B");
  expect(formatSize(1536)).toBe("1.5 KB");
  expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
});
