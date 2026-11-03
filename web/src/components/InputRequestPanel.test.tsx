import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi } from "vitest";
import { InputRequestPanel } from "./InputRequestPanel";
import type { InputRequest } from "../types";

const base: InputRequest = {
  id: 5, task_id: 7, kind: "permission", tool_name: "Bash", tool_input: { command: "rm -rf build", description: "clean" },
  summary: "Asks for permission: Bash — rm -rf build", state: "open", created_at: "",
};

it("permission: shows the command and returns allow/deny", async () => {
  const onDecide = vi.fn(async () => true);
  render(<InputRequestPanel request={base} pending={false} onDecide={onDecide} />);
  expect(screen.getByText("Agent waiting for permission")).toBeInTheDocument();
  expect(screen.getByText("rm -rf build")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(onDecide).toHaveBeenLastCalledWith({ behavior: "allow", scope: "once" });
  await userEvent.click(screen.getByRole("button", { name: "Allow for the rest of the session" }));
  expect(onDecide).toHaveBeenLastCalledWith({ behavior: "allow", scope: "session" });
  // A denial comes with a reason that goes to the agent
  await userEvent.click(screen.getByRole("button", { name: "Deny…" }));
  await userEvent.type(screen.getByPlaceholderText(/Why not/), "build is needed");
  await userEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onDecide).toHaveBeenLastCalledWith({ behavior: "deny", message: "build is needed" });
});

const question: InputRequest = {
  ...base, kind: "question", tool_name: "AskUserQuestion", summary: "Asks: What color? (red · blue)",
  tool_input: {
    questions: [
      { question: "What color?", header: "Color", multiSelect: false, options: [{ label: "red", description: "warm" }, { label: "blue", description: "cold" }] },
      { question: "Which sizes?", header: "Size", multiSelect: true, options: [{ label: "S" }, { label: "M" }] },
    ],
  },
};

it("question: options as buttons, multiple choice through a comma, the button waits for all answers", async () => {
  const onDecide = vi.fn(async () => true);
  render(<InputRequestPanel request={question} pending={false} onDecide={onDecide} />);
  expect(screen.getByText("Agent waiting for reply")).toBeInTheDocument();
  expect(screen.getByText("What color?")).toBeInTheDocument();
  expect(screen.getByText("cold")).toBeInTheDocument();
  const submit = screen.getByRole("button", { name: "Reply" });
  expect(submit).toBeDisabled();
  await userEvent.click(screen.getByRole("radio", { name: /blue/ }));
  expect(submit).toBeDisabled(); // the second question has no answer
  await userEvent.click(screen.getByRole("checkbox", { name: /^S/ }));
  await userEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
  expect(submit).toBeEnabled();
  await userEvent.click(submit);
  expect(onDecide).toHaveBeenCalledWith({ answers: { "What color?": "blue", "Which sizes?": "S, M" } });
});

it("question: a custom answer beats the selected option", async () => {
  const onDecide = vi.fn(async () => true);
  const questions = question.tool_input!.questions as unknown[];
  const single: InputRequest = { ...question, tool_input: { questions: [questions[0]] } };
  render(<InputRequestPanel request={single} pending={false} onDecide={onDecide} />);
  await userEvent.click(screen.getByRole("radio", { name: /red/ }));
  await userEvent.type(screen.getByPlaceholderText("Custom answer (instead of the options)"), "green");
  await userEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(onDecide).toHaveBeenCalledWith({ answers: { "What color?": "green" } });
});

it("plan: approve or send back with comments", async () => {
  const onDecide = vi.fn(async () => true);
  const plan: InputRequest = { ...base, kind: "plan", tool_name: "ExitPlanMode", tool_input: { plan: "1. step\n2. step" }, summary: "Waiting for plan approval" };
  render(<InputRequestPanel request={plan} pending={false} onDecide={onDecide} />);
  expect(screen.getByText("Agent waiting for plan approval")).toBeInTheDocument();
  expect(screen.getByText(/1\. step/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Approve plan" }));
  expect(onDecide).toHaveBeenLastCalledWith({ behavior: "allow" });
  await userEvent.click(screen.getByRole("button", { name: "Return with notes…" }));
  const back = screen.getByRole("button", { name: "Return with notes" });
  expect(back).toBeDisabled(); // nothing to send back without comments
  await userEvent.type(screen.getByPlaceholderText(/What to fix/), "add tests");
  await userEvent.click(back);
  expect(onDecide).toHaveBeenLastCalledWith({ behavior: "deny", message: "add tests" });
});
