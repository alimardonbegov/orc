import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class merging with Tailwind conflict resolution: the className prop always beats the base one. */
export function cn(...parts: ClassValue[]): string {
  return twMerge(clsx(parts));
}
