import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { FAILURE_CODES } from "../failures";
import { LanguageProvider } from "../i18n";
import { FailureLine } from "./ConversationRows";

afterEach(() => localStorage.clear());

const row = (code: string | null | undefined, detail = "fatal: unable to read state.json") => ({ kind: "failure" as const, id: "failure", detail, code, at: null });

it.each(FAILURE_CODES)("%s reads as a sentence with a next step, and the raw text waits behind a click", async (code) => {
  render(<FailureLine row={row(code)} />);
  expect(screen.getByTestId("failure-reason").textContent).toMatch(/\w/);
  expect(screen.getByTestId("failure-hint").textContent).toMatch(/«/);
  expect(screen.queryByText("fatal: unable to read state.json")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Technical details" }));
  expect(screen.getByTestId("failure-detail")).toHaveTextContent("fatal: unable to read state.json");
  await userEvent.click(screen.getByRole("button", { name: "Hide details" }));
  expect(screen.queryByTestId("failure-detail")).not.toBeInTheDocument();
});

it("an unknown code shows the text as before, without losing it", () => {
  render(<FailureLine row={row("a_reason_from_a_newer_server", "the full old text")} />);
  expect(screen.getByText("the full old text")).toBeInTheDocument();
  expect(screen.queryByTestId("failure-reason")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Technical details" })).not.toBeInTheDocument();
});

it("an older card without a code shows the text as before", () => {
  render(<FailureLine row={row(undefined, "tests are red")} />);
  expect(screen.getByTestId("failure-row")).toHaveTextContent("tests are red");
  expect(screen.queryByTestId("failure-hint")).not.toBeInTheDocument();
});

it("speaks the owner's language", () => {
  localStorage.setItem("orc.language.v1", "ru");
  render(<LanguageProvider><FailureLine row={row("session_lost")} /></LanguageProvider>);
  expect(screen.getByTestId("failure-reason")).toHaveTextContent("Сессия потеряна.");
  expect(screen.getByTestId("failure-hint")).toHaveTextContent("«Продолжить»");
});
