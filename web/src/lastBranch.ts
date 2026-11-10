/**
 * The base branch the person picked for the previous new task, remembered per project.
 *
 * It is only a convenience: tasks of one project usually go to the same branch, so the form opens
 * with it instead of the project base. Storage can be unavailable (private mode, blocked data), so
 * every access is guarded and a failure just means "no remembered branch".
 */
const key = (projectId: number) => `orc.lastBranch.${projectId}`;

export function readLastBranch(projectId: number): string | null {
  try {
    return localStorage.getItem(key(projectId)) || null;
  } catch {
    return null;
  }
}

export function writeLastBranch(projectId: number, branch: string | null): void {
  try {
    if (branch) localStorage.setItem(key(projectId), branch);
    else localStorage.removeItem(key(projectId));
  } catch {
    // The preference is not worth failing the form over.
  }
}
