import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { DescriptionEditor } from "./DescriptionEditor";
import { DescriptionView } from "./DescriptionView";

const uploadAttachment = vi.fn();
vi.mock("../api", () => ({ api: { uploadAttachment: (...a: unknown[]) => uploadAttachment(...a) } }));

beforeEach(() => {
  uploadAttachment.mockReset();
  uploadAttachment.mockResolvedValue({ id: 7, filename: "shot.png", mime: "image/png", size: 4, url: "/api/attachments/7" });
});

const png = () => new File([new Uint8Array([1, 2, 3, 4])], "shot.png", { type: "image/png" });

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DescriptionEditor label="Task for the agent" placeholder="what to do" value={value} onChange={setValue} />
      <pre data-testid="raw">{value}</pre>
    </>
  );
}

const raw = () => screen.getByTestId("raw").textContent;

it("the chosen image lands as a marker at the cursor position", async () => {
  render(<Harness initial="beforeafter" />);
  const area = screen.getByRole("textbox", { name: "Task for the agent" }) as HTMLTextAreaElement;
  area.setSelectionRange(6, 6);
  fireEvent.change(screen.getByLabelText("Choose an image"), { target: { files: [png()] } });
  await waitFor(() => expect(raw()).toBe("before\n![shot.png](orc-image:7)\nafter"));
  expect(uploadAttachment).toHaveBeenCalledWith({ filename: "shot.png", mime: "image/png", data: expect.any(String) });
});

it("a screenshot from the clipboard is pasted as an image, not as text", async () => {
  render(<Harness />);
  const file = png();
  fireEvent.paste(screen.getByRole("textbox", { name: "Task for the agent" }), {
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file] },
  });
  await waitFor(() => expect(raw()).toContain("orc-image:7"));
});

it("an ordinary text paste does not touch the image", () => {
  render(<Harness initial="was" />);
  fireEvent.paste(screen.getByRole("textbox", { name: "Task for the agent" }), {
    clipboardData: { items: [{ kind: "string", type: "text/plain" }], files: [] },
  });
  expect(uploadAttachment).not.toHaveBeenCalled();
  expect(raw()).toBe("was");
});

it("a dropped file is uploaded", async () => {
  render(<Harness />);
  const file = png();
  fireEvent.drop(screen.getByRole("textbox", { name: "Task for the agent" }), {
    dataTransfer: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file] },
  });
  await waitFor(() => expect(raw()).toContain("orc-image:7"));
});

it("a non-image does not reach the server and is explained on the spot", async () => {
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Choose an image"), {
    target: { files: [new File(["%PDF"], "doc.pdf", { type: "application/pdf" })] },
  });
  expect(await screen.findByText(/needs to be a/)).toBeInTheDocument();
  expect(uploadAttachment).not.toHaveBeenCalled();
});

it("a server refusal is shown, and the text is not corrupted", async () => {
  uploadAttachment.mockRejectedValue(new Error("file is larger than 10 MB"));
  render(<Harness initial="text" />);
  fireEvent.change(screen.getByLabelText("Choose an image"), { target: { files: [png()] } });
  expect(await screen.findByText("file is larger than 10 MB")).toBeInTheDocument();
  expect(raw()).toBe("text");
});

it("the preview shows the image in place of the marker", async () => {
  render(<Harness initial={`before\n![diagram](orc-image:4)\nafter`} />);
  await userEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect(screen.getByRole("img", { name: "diagram" })).toHaveAttribute("src", "/api/attachments/4");
  // There is no input field in the preview: there is nowhere to show the marker, and the image is already in its place
  expect(screen.queryByRole("textbox", { name: "Task for the agent" })).not.toBeInTheDocument();
});

it("the image counter is visible while the text is being edited", () => {
  render(<Harness initial={`![a](orc-image:1) ![b](orc-image:2)`} />);
  expect(screen.getByText("images: 2")).toBeInTheDocument();
});

it("the view renders text and images in the original order", () => {
  render(<DescriptionView text={`start\n![header](orc-image:9)\nend`} />);
  expect(screen.getByRole("img", { name: "header" })).toHaveAttribute("src", "/api/attachments/9");
  expect(screen.getByText(/start/)).toBeInTheDocument();
  expect(screen.getByText(/end/)).toBeInTheDocument();
  // The image opens at full size: it is shrunk in the card
  expect(screen.getByRole("link")).toHaveAttribute("href", "/api/attachments/9");
});
