import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { focusRing } from "./tokens";

interface Props {
  title: string;
  /** A number beside the title: how many things are inside. */
  count?: number;
  /** Buttons at the right end of the header; they sit beside the toggle, not inside it. */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * A collapsible section of a side column: a chevron, the title, a count and a slot for actions, after
 * multica's issue-sidebar-section. One component so that every section header in the card looks and
 * behaves the same, and so `aria-expanded` is never forgotten.
 */
export function SidebarSection({ title, count, actions, defaultOpen = false, open, onOpenChange, children, className }: Props) {
  const [inner, setInner] = useState(defaultOpen);
  const expanded = open ?? inner;
  const bodyId = useId();
  const toggle = () => {
    if (open === undefined) setInner(!expanded);
    onOpenChange?.(!expanded);
  };
  return (
    <section className={cn("border-t border-[var(--line)] px-1.5 pt-2", className)}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={toggle}
          className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded text-left text-[12px] font-medium text-[var(--ink-muted)] hover:text-[var(--ink)]", focusRing)}
        >
          <ChevronRight size={12} aria-hidden className={cn("shrink-0 transition-transform duration-100", expanded && "rotate-90")} />
          <span className="truncate">{title}</span>
          {count !== undefined && <span className="tnum text-[11px] font-normal text-[var(--ink-faint)]">{count}</span>}
        </button>
        {actions}
      </div>
      <div id={bodyId} hidden={!expanded} className="mt-2">
        {/* Rendered while closed, like <details>: a closed section keeps its state and its text stays findable */}
        {children}
      </div>
    </section>
  );
}
