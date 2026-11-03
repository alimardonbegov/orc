/**
 * Two-letter monogram for a project name: "Orchestrator API" → "OA", "orc" → "OR".
 *
 * The project mark in the collapsed sidebar and in the event feed is the same monogram,
 * hence one function: otherwise one project would look different in two places.
 */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_\-./]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || "?";
}
