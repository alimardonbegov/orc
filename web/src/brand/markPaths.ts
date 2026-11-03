/**
 * Outlines of the orc mark on a 32×32 grid: the single source of geometry. They live apart from the
 * component so that OrcMark.tsx exports only the component (otherwise fast refresh breaks). The
 * same paths are repeated in web/public/favicon.svg and web/public/brand/*.svg: when the mark is
 * edited, those must be changed too (see docs/design/brand.md, the "Files" section).
 */
export const ORC_MARK_PATHS = {
  skull: "M5 4h22l3 9-2 5H4l-2-5z",
  ears: "M3.2 9 0 5.5 2.4 15z M28.8 9 32 5.5 29.6 15z",
  jaw: "M6 23h20l-3 6H9z",
  tusks: "M6.5 23 9.5 13.5l3 9.5z M19.5 23 22.5 13.5l3 9.5z",
  eyes: "M8.5 11.5l5.5-1.5V14H8.5z M23.5 11.5l-5.5-1.5V14h5.5z",
} as const;

