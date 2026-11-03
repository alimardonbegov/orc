import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Chart tooltip: one per card, attached to the mark that was hovered, tapped or
 * selected via keyboard.
 *
 * Why not the `title` attribute and not a Radix Tooltip. `title` appears after a second, is
 * not shown on touch screens at all and cannot render colored series keys. Radix Tooltip
 * deliberately does not open on touch (by design: a tooltip is for hovering). But a bar
 * on the dashboard is the only place that holds the bucket breakdown, and it must be
 * reachable by finger and by Tab. Hence our own layer: hover shows immediately, tap
 * pins (a second tap or a tap elsewhere unpins), and focus shows the same as hover.
 *
 * The layer is drawn inside the card (position: relative on the wrapper), not in a portal: the card
 * does not clip the content, and coordinates relative to it do not depend on page scrolling.
 */

export interface TipAnchor {
  /** Mark center on X and its top on Y — in wrapper coordinates. */
  x: number;
  y: number;
  /** Mark key: a second tap on the same mark unpins it. */
  id: string;
  content: ReactNode;
  pinned: boolean;
}

export function useChartTip() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TipAnchor | null>(null);

  const place = useCallback((target: Element, id: string, content: ReactNode, pinned: boolean) => {
    const host = hostRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const mark = target.getBoundingClientRect();
    setTip((current) => {
      if (current?.pinned && !pinned) return current; // hover does not dislodge a tooltip pinned by tap
      return { x: mark.left + mark.width / 2 - box.left, y: mark.top - box.top, id, content, pinned };
    });
  }, []);

  const hide = useCallback((force = false) => {
    setTip((current) => (current && current.pinned && !force ? current : null));
  }, []);

  // A tooltip pinned by tap is dismissed by tapping elsewhere and by the Escape key
  useEffect(() => {
    if (!tip?.pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setTip(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTip(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [tip?.pinned]);

  /** Handlers for a mark: attached to a bar button, segment or row. */
  const bind = useCallback(
    (id: string, content: ReactNode) => ({
      onPointerEnter: (e: React.PointerEvent<Element>) => {
        if (e.pointerType === "touch") return; // on touch we wait for click: otherwise the tap would show it and immediately dismiss it
        place(e.currentTarget, id, content, false);
      },
      onPointerLeave: () => hide(),
      onFocus: (e: React.FocusEvent<Element>) => place(e.currentTarget, id, content, false),
      onBlur: () => hide(),
      onClick: (e: React.MouseEvent<Element>) => {
        // A repeated click on a pinned mark unpins it, any other one pins
        const target = e.currentTarget;
        setTip((current) => {
          if (current?.pinned && current.id === id) return null;
          const host = hostRef.current;
          if (!host) return current;
          const box = host.getBoundingClientRect();
          const mark = target.getBoundingClientRect();
          return { x: mark.left + mark.width / 2 - box.left, y: mark.top - box.top, id, content, pinned: true };
        });
      },
    }),
    [place, hide],
  );

  return { hostRef, tip, bind, hide };
}

/** The layer itself: placed as the last child of a wrapper with `position: relative`. */
export function ChartTipLayer({ tip }: { tip: TipAnchor | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  // The tooltip must not stick out of the card: after rendering we measure and shift it toward the edge
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const host = el.parentElement;
    if (!host) return;
    const width = el.offsetWidth;
    const hostWidth = host.clientWidth;
    const left = tip.x - width / 2;
    const right = tip.x + width / 2;
    setShift(left < 4 ? 4 - left : right > hostWidth - 4 ? hostWidth - 4 - right : 0);
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-20 max-w-[340px] rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--raised)] px-2 py-1.5 text-[11px] leading-snug text-[var(--ink)] shadow-[var(--shadow-pop)]",
      )}
      style={{ left: tip.x + shift, top: tip.y, transform: "translate(-50%, calc(-100% - 6px))" }}
    >
      {tip.content}
    </div>
  );
}

/**
 * Tooltip body in a uniform form: heading, rows "series key · label · value".
 * The value is the main thing and brighter than the label: the reader already has the series, they need the number.
 */
export function TipBody({
  title,
  rows,
  foot,
}: {
  title?: ReactNode;
  rows: { key: string; label: ReactNode; value: ReactNode; tone?: string }[];
  foot?: ReactNode;
}) {
  return (
    <div className="min-w-[140px]">
      {title && <p className="m-0 mb-1 font-medium text-[var(--ink)]">{title}</p>}
      <dl className="m-0 grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 gap-y-0.5">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <span aria-hidden className="inline-block h-[2px] w-3 self-center rounded-[1px]" style={{ background: row.tone ?? "transparent" }} />
            <dt className="max-w-[200px] truncate text-[var(--ink-muted)]">{row.label}</dt>
            <dd className="tnum m-0 text-right font-mono font-medium text-[var(--ink)]">{row.value}</dd>
          </div>
        ))}
      </dl>
      {foot && <p className="m-0 mt-1 text-[var(--ink-faint)]">{foot}</p>}
    </div>
  );
}
