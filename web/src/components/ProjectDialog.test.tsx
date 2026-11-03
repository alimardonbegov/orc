import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, vi, describe, beforeEach } from "vitest";
import { ProjectDialog } from "./ProjectDialog";
import { AppHiddenModelsContext } from "../hiddenModels";
import { api } from "../api";
import type { ClaudeMd, ClaudeMdFile, Project, ProjectPathCheck } from "../types";

vi.mock("../api", () => ({
  api: {
    addProject: vi.fn(), patchProject: vi.fn(), claudeMd: vi.fn(), saveClaudeMd: vi.fn(),
    moveProject: vi.fn(), archiveProject: vi.fn(), unarchiveProject: vi.fn(), checkProjectPath: vi.fn(),
    branches: vi.fn(async () => ({ current: "main", default_branch: null, base: "main", branches: ["main", "dev"], items: [] })),
  },
}));

const root = (over: Partial<ClaudeMdFile> = {}): ClaudeMdFile => ({
  location: "root", rel: "CLAUDE.md", path: "/repo/a/CLAUDE.md",
  exists: true, content: "rule\n", sha: "sha-1", error: null, ...over,
});
const claudeDir = (over: Partial<ClaudeMdFile> = {}): ClaudeMdFile => ({
  location: "claude-dir", rel: ".claude/CLAUDE.md", path: "/repo/a/.claude/CLAUDE.md",
  exists: false, content: "", sha: null, error: null, ...over,
});
const memory = (...files: ClaudeMdFile[]): ClaudeMd => ({ files: files.length ? files : [root(), claudeDir()] });

const pathCheck = (over: Partial<ProjectPathCheck> = {}): ProjectPathCheck => ({
  path: "/repo/new", status: "ok", can_init: false, message: null, ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.claudeMd).mockResolvedValue(memory());
  vi.mocked(api.checkProjectPath).mockResolvedValue(pathCheck());
});

const projectA: Project = {
  id: 1, name: "Project A", path: "/repo/a", default_model: null, default_effort: null,
  default_permission_mode: "auto", default_branch: null, verify_cmd: "npm test", verify_timeout_sec: 900,
  max_workers: 2, push_enabled: 0, archived_at: null, path_ok: true, path_error: null, created_at: "", position: null,
};
const projectB: Project = {
  id: 2, name: "Project B", path: "/repo/b", default_model: "claude-opus-5", default_effort: "high",
  default_permission_mode: "auto", default_branch: "dev", verify_cmd: "pytest", verify_timeout_sec: 900,
  max_workers: 1, push_enabled: 1, archived_at: null, path_ok: true, path_error: null, created_at: "", position: null,
};

const open = (project: Project | null, onSaved = vi.fn()) => {
  const r = render(<ProjectDialog open onOpenChange={vi.fn()} project={project} onSaved={onSaved} />);
  return { ...r, onSaved };
};

describe("project settings", () => {
  it("edits pile up in a draft and are sent in a single request on the button", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProject).mockResolvedValue({ ...projectA, default_model: "claude-opus-5" });
    open(projectA);

    // While nothing has changed there is nothing to save, the button is disabled.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: "Model" }), "claude-opus-5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "high");
    // Choosing from a list sends nothing by itself: settings used to go
    // silently when focus left, and there was no way to tell whether they were saved.
    expect(api.patchProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.patchProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.patchProject).mock.calls[0][1]).toMatchObject({
      default_model: "claude-opus-5",
      default_effort: "high",
      name: "Project A",
      verify_cmd: "npm test",
    });
  });

  it("switching the project fills in its values, not those of the previous one", async () => {
    const { rerender } = render(
      <ProjectDialog open onOpenChange={vi.fn()} project={projectA} onSaved={vi.fn()} />,
    );
    expect(screen.getByDisplayValue("npm test")).toBeInTheDocument();

    rerender(<ProjectDialog open onOpenChange={vi.fn()} project={projectB} onSaved={vi.fn()} />);
    expect(screen.getByDisplayValue("pytest")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("npm test")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("claude-opus-5");
  });

  it("a new project requires a name and a path", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addProject).mockResolvedValue({ ...projectA, id: 9, name: "New", path: "/repo/new" });
    const { onSaved } = open(null);

    const add = screen.getByRole("button", { name: "Add project" });
    expect(add).toBeDisabled();

    await user.type(screen.getByPlaceholderText("What to call the project on the board"), "New");
    expect(add).toBeDisabled(); // a name alone is not enough
    await user.type(screen.getByPlaceholderText("/Users/me/Projects/my-repo"), "/repo/new");
    await user.click(add);

    await waitFor(() => expect(api.addProject).toHaveBeenCalled());
    expect(vi.mocked(api.addProject).mock.calls[0][0]).toMatchObject({ name: "New", path: "/repo/new", init_git: false });
    expect(onSaved).toHaveBeenCalled();
  });

  it("an empty path is not a refusal but a choice: cancel or create a folder with git", async () => {
    const user = userEvent.setup();
    vi.mocked(api.checkProjectPath).mockResolvedValue(
      pathCheck({ status: "missing", can_init: true, message: "folder /repo/new does not exist" }),
    );
    vi.mocked(api.addProject).mockResolvedValue({ ...projectA, id: 9, name: "New", path: "/repo/new" });
    const { onSaved } = open(null);

    await user.type(screen.getByPlaceholderText("What to call the project on the board"), "New");
    await user.type(screen.getByPlaceholderText("/Users/me/Projects/my-repo"), "/repo/new");
    await user.click(screen.getByRole("button", { name: "Add project" }));

    // Until the person agrees, nothing is created on disk.
    await screen.findByText("No folder at this path");
    expect(api.addProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create folder and add" }));
    await waitFor(() => expect(api.addProject).toHaveBeenCalled());
    // The consent goes to the server as an explicit flag: without it the answer would be the same refusal.
    expect(vi.mocked(api.addProject).mock.calls[0][0]).toMatchObject({ path: "/repo/new", init_git: true });
    expect(onSaved).toHaveBeenCalled();
  });

  it("cancelling at the fork leaves the project uncreated", async () => {
    const user = userEvent.setup();
    vi.mocked(api.checkProjectPath).mockResolvedValue(
      pathCheck({ status: "no_git", can_init: true, message: "there is no git repository in folder /repo/new" }),
    );
    open(null);

    await user.type(screen.getByPlaceholderText("What to call the project on the board"), "New");
    await user.type(screen.getByPlaceholderText("/Users/me/Projects/my-repo"), "/repo/new");
    await user.click(screen.getByRole("button", { name: "Add project" }));

    await screen.findByText("No git in this folder");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.addProject).not.toHaveBeenCalled();
    // The project dialog is still there: the path can be fixed and tried again.
    expect(screen.getByRole("button", { name: "Add project" })).toBeEnabled();
  });

  it("an unfixable path is shown as an error, not as a fork", async () => {
    const user = userEvent.setup();
    vi.mocked(api.checkProjectPath).mockResolvedValue(
      pathCheck({ status: "occupied", can_init: false, message: "this folder is already taken by project \"Project A\"" }),
    );
    open(null);

    await user.type(screen.getByPlaceholderText("What to call the project on the board"), "New");
    await user.type(screen.getByPlaceholderText("/Users/me/Projects/my-repo"), "/repo/new");
    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(await screen.findByText("this folder is already taken by project \"Project A\"")).toBeInTheDocument();
    expect(api.addProject).not.toHaveBeenCalled();
  });

  it("CLAUDE.md is read on open and saved with the same button", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveClaudeMd).mockResolvedValue(root({ content: "rule\nmore\n", sha: "sha-2" }));
    const { onSaved } = open(projectA);

    const editor = await screen.findByRole("textbox", { name: "CLAUDE.md" });
    expect(editor).toHaveValue("rule\n");
    expect(api.claudeMd).toHaveBeenCalledWith(1);

    await user.type(editor, "more");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveClaudeMd).toHaveBeenCalledTimes(1));
    // The fingerprint of what was read goes along with the text: we do not overwrite someone else's edit of the file.
    expect(vi.mocked(api.saveClaudeMd).mock.calls[0][1]).toEqual({
      location: "root", content: "rule\nmore", prev_sha: "sha-1",
    });
    // The project fields were not touched, so there must be no extra PATCH.
    expect(api.patchProject).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it("a file conflict is shown in the dialog, and the project settings are not sent", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveClaudeMd).mockRejectedValue(new Error("CLAUDE.md changed on disk"));
    const onOpenChange = vi.fn();
    render(<ProjectDialog open onOpenChange={onOpenChange} project={projectA} onSaved={vi.fn()} />);

    const editor = await screen.findByRole("textbox", { name: "CLAUDE.md" });
    await user.type(editor, "!");
    await user.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "low");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("CLAUDE.md changed on disk")).toBeInTheDocument();
    expect(api.patchProject).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("if the file does not exist, a \"Create\" button replaces the empty field, and it creates exactly .claude/CLAUDE.md", async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveClaudeMd).mockResolvedValue(claudeDir({ exists: true, content: "memory\n", sha: "sha-9" }));
    open(projectA);

    // An empty input field cannot be told from an empty file, so a nonexistent location gets a button.
    await screen.findByText(".claude/CLAUDE.md");
    expect(screen.queryByRole("textbox", { name: ".claude/CLAUDE.md" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create" }));
    const editor = screen.getByRole("textbox", { name: ".claude/CLAUDE.md" });
    // The template is already in the field: there is something to save, the button is enabled.
    expect((editor as HTMLTextAreaElement).value).toContain("# Project memory");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveClaudeMd).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveClaudeMd).mock.calls[0][1]).toMatchObject({ location: "claude-dir", prev_sha: null });
  });

  it("both locations are edited with a single save", async () => {
    const user = userEvent.setup();
    vi.mocked(api.claudeMd).mockResolvedValue(
      memory(root(), claudeDir({ exists: true, content: "second\n", sha: "sha-d" })),
    );
    vi.mocked(api.saveClaudeMd).mockImplementation(async (_id, body) =>
      body.location === "root" ? root({ sha: "sha-2" }) : claudeDir({ exists: true, sha: "sha-e" }),
    );
    open(projectA);

    await user.type(await screen.findByRole("textbox", { name: "CLAUDE.md" }), "!");
    await user.type(screen.getByRole("textbox", { name: ".claude/CLAUDE.md" }), "?");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveClaudeMd).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.saveClaudeMd).mock.calls.map((c) => c[1].location)).toEqual(["root", "claude-dir"]);
  });

  it("an unreadable file explains the reason and does not disable the second location", async () => {
    vi.mocked(api.claudeMd).mockResolvedValue(
      memory(root({ exists: false, content: "", sha: null, error: "/repo/a/CLAUDE.md — not a file" }), claudeDir()),
    );
    open(projectA);

    expect(await screen.findByText(/not a file/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "CLAUDE.md" })).not.toBeInTheDocument();
    // The second location stayed working: the "Create" button is in place.
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("a new project has no CLAUDE.md editor: there is nothing to read the file from", async () => {
    open(null);
    expect(screen.queryByRole("textbox", { name: "CLAUDE.md" })).not.toBeInTheDocument();
    expect(api.claudeMd).not.toHaveBeenCalled();
  });

  it("a server refusal is shown in the dialog, and the dialog does not close", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProject).mockRejectedValue(new Error("path unavailable"));
    const onOpenChange = vi.fn();
    render(<ProjectDialog open onOpenChange={onOpenChange} project={projectA} onSaved={vi.fn()} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Effort" }), "low");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("path unavailable")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
  it("the base branch of new tasks is chosen from the repository branches and goes into the save", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProject).mockResolvedValue(projectA);
    open(projectA);

    const select = await screen.findByRole("combobox", { name: "Base branch for new tasks" });
    // While the setting is empty, the base is the branch open in the repository
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: /the one open in the repository \(currently main\)/ })).toBeInTheDocument();
    await user.selectOptions(select, "dev");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.patchProject).toHaveBeenCalled());
    expect(vi.mocked(api.patchProject).mock.calls[0][1]).toMatchObject({ default_branch: "dev" });
  });

  it("a vanished base branch is not silently replaced", async () => {
    open({ ...projectA, default_branch: "deleted" });
    const select = await screen.findByRole("combobox", { name: "Base branch for new tasks" });
    await waitFor(() => expect(select).toHaveValue("deleted"));
    expect(screen.getByRole("option", { name: "deleted — this branch no longer exists" })).toBeInTheDocument();
  });
});

describe("project path and archive", () => {
  it("the path of an existing project is edited and goes as a separate move request", async () => {
    const user = userEvent.setup();
    const moved = { ...projectA, path: "/repo/moved" };
    vi.mocked(api.moveProject).mockResolvedValue({ project: moved, relinked: 2, warnings: [] });
    const { onSaved } = open(projectA);

    const path = screen.getByDisplayValue("/repo/a");
    await user.clear(path);
    await user.type(path, "/repo/moved");
    // The button honestly names what will happen: it is not the ordinary "Save".
    await user.click(screen.getByRole("button", { name: "Change path and save" }));

    await waitFor(() => expect(api.moveProject).toHaveBeenCalledWith(1, "/repo/moved"));
    // The path went as its own request, the project fields did not change, so there must be no extra PATCH.
    expect(api.patchProject).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it("a move refusal is shown in the dialog, the path is no longer sent to the server", async () => {
    const user = userEvent.setup();
    vi.mocked(api.moveProject).mockRejectedValue(new Error("first stop the tasks that are running now: #3"));
    const onOpenChange = vi.fn();
    render(<ProjectDialog open onOpenChange={onOpenChange} project={projectA} onSaved={vi.fn()} />);

    const path = screen.getByDisplayValue("/repo/a");
    await user.clear(path);
    await user.type(path, "/repo/other");
    await user.click(screen.getByRole("button", { name: "Change path and save" }));

    expect(await screen.findByText(/first stop the tasks/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("a project with a missing folder says what to do right at the path field", () => {
    open({ ...projectA, path_ok: false, path_error: "folder missing" });
    expect(screen.getByText(/Folder unavailable: folder missing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to archive" })).toBeInTheDocument();
  });

  it("archive and unarchive are one button depending on the project state", async () => {
    const user = userEvent.setup();
    vi.mocked(api.archiveProject).mockResolvedValue({ ...projectA, archived_at: "2026-01-01T00:00:00" });
    const { onSaved, unmount } = open(projectA);
    await user.click(screen.getByRole("button", { name: "Move to archive" }));
    await waitFor(() => expect(api.archiveProject).toHaveBeenCalledWith(1));
    expect(onSaved).toHaveBeenCalled();
    unmount();

    vi.mocked(api.unarchiveProject).mockResolvedValue(projectA);
    open({ ...projectA, archived_at: "2026-01-01T00:00:00" });
    await user.click(screen.getByRole("button", { name: "Restore from archive" }));
    await waitFor(() => expect(api.unarchiveProject).toHaveBeenCalledWith(1));
  });
});

describe("model visibility in the project", () => {
  const modelValues = () =>
    Array.from(screen.getByRole("combobox", { name: "Model" }).querySelectorAll("option")).map((o) => o.value);
  const openWithAppHidden = (project: Project, appHidden: string[]) =>
    render(
      <AppHiddenModelsContext.Provider value={appHidden}>
        <ProjectDialog open onOpenChange={vi.fn()} project={project} onSaved={vi.fn()} />
      </AppHiddenModelsContext.Provider>,
    );

  it("without its own list the shared one from the orc settings applies, and it cannot be edited here", () => {
    openWithAppHidden(projectA, ["claude-opus-5"]);
    expect(modelValues()).not.toContain("claude-opus-5");
    expect(screen.getByRole("checkbox", { name: "Opus 5" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Opus 5" })).not.toBeChecked();
  });

  it("its own list starts from the shared one, the dropdown changes immediately and goes into PATCH", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProject).mockResolvedValue({ ...projectA, hidden_models: ["claude-sonnet-5"] });
    openWithAppHidden(projectA, ["claude-opus-5"]);

    await user.click(screen.getByRole("switch", { name: /Own list for this project/ }));
    // Restored a model hidden everywhere and hid another one, only in this project
    await user.click(screen.getByRole("checkbox", { name: "Opus 5" }));
    await user.click(screen.getByRole("checkbox", { name: "Sonnet 5" }));
    expect(modelValues()).toContain("claude-opus-5");
    expect(modelValues()).not.toContain("claude-sonnet-5");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.patchProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.patchProject).mock.calls[0][1]).toMatchObject({ hidden_models: ["claude-sonnet-5"] });
  });

  it("turning off its own list returns the project to the shared one (null)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.patchProject).mockResolvedValue(projectA);
    openWithAppHidden({ ...projectA, hidden_models: [] }, ["claude-opus-5"]);
    expect(modelValues()).toContain("claude-opus-5");

    await user.click(screen.getByRole("switch", { name: /Own list for this project/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.patchProject).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.patchProject).mock.calls[0][1]).toMatchObject({ hidden_models: null });
  });
});
