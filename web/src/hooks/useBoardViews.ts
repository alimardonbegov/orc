import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BoardFilters, BoardView } from "../types";

/** Filters equal, ignoring the order of keys: whether the board currently shows exactly this view. */
export function sameFilters(a: BoardFilters, b: BoardFilters): boolean {
  return (
    a.search.trim() === b.search.trim() &&
    a.attention_only === b.attention_only &&
    a.label_id === b.label_id &&
    a.show_done === b.show_done &&
    a.show_archived === b.show_archived &&
    a.done_sort === b.done_sort
  );
}

/**
 * The saved views of one project. They live on the server, so after a reload (or on another device) they are
 * still there. `supported` is false against an older server that has no views: the menu hides itself.
 */
export function useBoardViews(projectId: number | null) {
  const [views, setViews] = useState<BoardView[]>([]);
  const [supported, setSupported] = useState(true);

  const reload = useCallback(async () => {
    if (projectId === null) return;
    try {
      const list = await api.listViews(projectId);
      // Anything but a list of views (a server that answers with something else) counts as no support
      if (!Array.isArray(list) || list.some((v) => typeof v?.filters !== "object")) throw new Error("no views");
      setViews(list);
      setSupported(true);
    } catch {
      setViews([]);
      setSupported(false);
    }
  }, [projectId]);

  useEffect(() => {
    setViews([]);
    void reload();
  }, [reload]);

  return { views, supported, reload };
}
