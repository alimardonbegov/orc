import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Label } from "../types";

/**
 * The list of labels, shared by everything on screen that shows or picks one: the board filter, the picker
 * in a card and in the creation form. One fetch serves them all, and a change made through `mutate`
 * reaches every subscriber at once.
 */
let cache: Label[] | null = null;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(labels: Label[]) => void>();

const publish = (labels: Label[]) => {
  cache = labels;
  subscribers.forEach((notify) => notify(labels));
};

function fetchLabels(): Promise<void> {
  inflight ??= api
    .listLabels()
    .then(publish)
    // An older server has no labels: the list stays empty and the rest of the card works as before
    .catch(() => publish(cache ?? []))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test hook: forget what was fetched. */
export function resetLabelsCache() {
  cache = null;
  inflight = null;
}

export function useLabels() {
  const [labels, setLabels] = useState<Label[]>(cache ?? []);
  useEffect(() => {
    subscribers.add(setLabels);
    if (cache === null) void fetchLabels();
    else setLabels(cache);
    return () => {
      subscribers.delete(setLabels);
    };
  }, []);

  /** Create a label from the picker. The name is unique ignoring case, so an existing one is returned as it is. */
  const create = useCallback(async (name: string): Promise<Label> => {
    const existing = (cache ?? []).find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
    if (existing) return existing;
    const made = await api.addLabel(name.trim());
    publish([...(cache ?? []), made].sort((a, b) => a.name.localeCompare(b.name)));
    return made;
  }, []);

  return { labels, create, reload: fetchLabels };
}

/** The label objects for these names, in the order of the names. A name the list does not know yet gets a neutral colour. */
export function labelsByName(names: readonly string[], known: readonly Label[]): Label[] {
  return names.map((name) => known.find((l) => l.name.toLowerCase() === name.toLowerCase()) ?? { id: -1, name, color: "#8b8b95" });
}
