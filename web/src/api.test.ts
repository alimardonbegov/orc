import { describe, it, expect, vi, beforeEach } from "vitest";
import { api, ApiError } from "./api";

describe("api", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("GET task list with parameters", async () => {
    (fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: 1 }] });
    const tasks = await api.listTasks({ project_id: 2, status: "todo" });
    expect(tasks).toEqual([{ id: 1 }]);
    expect((fetch as any).mock.calls[0][0]).toBe("/api/tasks?project_id=2&status=todo");
  });

  it("POST comment sends kind", async () => {
    (fetch as any).mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: 5 }) });
    await api.addComment(5, "8080", "answer");
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("/api/tasks/5/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ body: "8080", kind: "answer" });
  });

  it("archive and unarchive are POSTs to their own URLs", async () => {
    (fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 3 }) });
    await api.archive(3);
    await api.unarchive(3);
    expect((fetch as any).mock.calls.map((c: any[]) => [c[0], c[1].method])).toEqual([
      ["/api/tasks/3/archive", "POST"],
      ["/api/tasks/3/unarchive", "POST"],
    ]);
  });

  it("delete sends DELETE, and the confirmations go into the parameters", async () => {
    (fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ deleted: 4 }) });
    await api.deleteTask(4);
    await api.deleteTask(4, { force: true, dropWorktree: false });
    const calls = (fetch as any).mock.calls;
    expect(calls[0][0]).toBe("/api/tasks/4");
    expect(calls[0][1].method).toBe("DELETE");
    // Server defaults are not duplicated: only what the person changed ends up in the URL.
    expect(calls[1][0]).toBe("/api/tasks/4?force=1&drop_worktree=0");
  });

  it("a control panel page instead of JSON is explained in words, not as \"Unexpected token '<'\"", async () => {
    // This is how a server running old code answers: there is no route, and the SPA fallback picks it up.
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`);
      },
    });
    await expect(api.claudeMd(1)).rejects.toThrow(/restart it \(make restart\)/);
  });

  it("a non-2xx becomes an ApiError with detail", async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: "the task is not waiting for an answer" }) });
    await expect(api.retry(1)).rejects.toEqual(new ApiError(400, "the task is not waiting for an answer"));
  });
});
