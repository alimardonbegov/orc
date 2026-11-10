import { createContext, useContext } from "react";
import type { Progress } from "./relations";

/**
 * done/total of every parent card, computed once by App from all live cards (relations.ts subtaskProgress) and read by
 * each card on the board. Not from the board's own list: that one is filtered, and a parent's subtasks may live in
 * another project or be hidden by a filter.
 */
export const SubtaskProgressContext = createContext<ReadonlyMap<number, Progress>>(new Map());

export const useSubtaskProgress = (taskId: number) => useContext(SubtaskProgressContext).get(taskId);
