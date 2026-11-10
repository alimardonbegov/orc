import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  buildConversation,
  filterConversation,
  foldSteps,
  type ActivityFilter,
  type ActivitySource,
  type ConversationExtras,
  type ConversationRow,
} from "../activity";
import { useAgents } from "../agents";
import type { ActivityEvent, ActivityNow, Agent } from "../types";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { Segmented } from "../ui/Segmented";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";
import { EventRow, ToolRow } from "./ActivityFeed";
import { CommentLine, DelegateLine, FailureLine, HandoffLine, StageLine, StepsLine, WaitingLine } from "./ConversationRows";

const STICK_PX = 48;

function Row({ row, source, live, last, agent }: { row: ConversationRow; source: ActivitySource; live: boolean; last: boolean; agent: Agent | undefined }) {
  const { t } = useTranslation();
  switch (row.kind) {
    case "comment":
      return <CommentLine row={row} />;
    case "handoff":
      return <HandoffLine row={row} />;
    case "stage":
      return <StageLine row={row} />;
    case "waiting":
      return <WaitingLine row={row} agent={agent} />;
    case "failure":
      return <FailureLine row={row} />;
    case "delegate":
      return <DelegateLine row={row} source={source} live={live} />;
    case "steps":
      // The steps still coming in stay open: that is what the owner came to watch.
      return <StepsLine row={row} source={source} live={live} openByDefault={last && live} />;
    case "tool":
      return <ToolRow use={row.use} result={row.result} interrupted={row.interrupted} source={source} live={live} />;
    case "event":
      return <EventRow event={row.event} agent={agent} agentFace />;
    case "session":
      return (
        <li className="flex items-center gap-2 py-1.5 text-[11px] font-medium text-[var(--ink-muted)]">
          <span className="h-px flex-1 bg-[var(--line-strong)]" />
          {t("activity.newSession")}
          <span className="h-px flex-1 bg-[var(--line-strong)]" />
        </li>
      );
  }
}

interface Props {
  source: ActivitySource;
  events: ActivityEvent[];
  /** Comments, stages and delegations around the steps. */
  extras: ConversationExtras;
  now: ActivityNow | null;
  loaded: boolean;
  earlier: string | null;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /**
   * The element that scrolls the thread: the card's body or the agent window's pane. The thread has no
   * scroll of its own, so a card has one scroll, not one inside another.
   */
  scrollRoot: HTMLElement | null;
  /** Begin at the live end instead of where the root already is. */
  startAtEnd?: boolean;
  /** The last row: an open request's form. */
  tail?: ReactNode;
  /** Changes when the tail does, so the end is followed when the form appears. */
  tailKey?: string;
  /** The reader is in the thread but not at its end: the owner shows "to the latest". */
  onAway?: (away: boolean) => void;
  /** Filled with the jump to the end, for that button and for the card's status chip. */
  jumpRef?: MutableRefObject<(() => void) | null>;
  className?: string;
}

/**
 * One thread: the owner's words, the agent's answers, its steps folded between them, and the stages
 * of the task. It follows the live end only once the reader is there, and keeps the place when earlier
 * events are loaded above.
 */
export function ConversationFeed({ source, events, extras, now, loaded, earlier, loadingEarlier, onLoadEarlier, scrollRoot, startAtEnd = false, tail, tailKey, onAway, jumpRef, className }: Props) {
  const { t } = useTranslation();
  const agent = useAgents().find((a) => a.id === now?.agent_id);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [search, setSearch] = useState("");
  const live = Boolean(now?.live);
  const all = useMemo(() => buildConversation(events, extras, now, earlier === null), [events, extras, now, earlier]);
  const shown = useMemo(() => {
    const filtering = filter !== "all" || search.trim() !== "";
    // Filtering looks at single steps: folded, a match would stay hidden inside its group.
    return filtering ? filterConversation(all, filter, search) : foldSteps(all);
  }, [all, filter, search]);
  const list = useRef<HTMLDivElement>(null);
  // Only the reader's own scroll changes this: a card opens at the top, to read the task first.
  const following = useRef(startAtEnd);
  const prepended = useRef<number | null>(null);
  const onAwayRef = useRef(onAway);
  onAwayRef.current = onAway;

  useLayoutEffect(() => {
    const el = scrollRoot;
    if (!el) return;
    if (prepended.current !== null) {
      el.scrollTop += el.scrollHeight - prepended.current;
      prepended.current = null;
    } else if (following.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [shown, tailKey, scrollRoot]);

  useEffect(() => {
    const el = scrollRoot;
    if (!el) return;
    const onScroll = () => {
      const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
      following.current = atEnd;
      // Above the thread the owner is reading the task: no reason to call them down.
      const top = list.current?.getBoundingClientRect().top ?? 0;
      onAwayRef.current?.(!atEnd && top < el.getBoundingClientRect().bottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRoot]);

  useEffect(() => {
    if (!jumpRef) return;
    jumpRef.current = () => {
      if (scrollRoot) scrollRoot.scrollTop = scrollRoot.scrollHeight;
      following.current = true;
      onAwayRef.current?.(false);
    };
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef, scrollRoot]);

  const filterOptions: { value: ActivityFilter; label: string }[] = [
    { value: "all", label: t("activity.filter.all") },
    { value: "messages", label: t("activity.filter.messages") },
    { value: "tools", label: t("activity.filter.tools") },
    { value: "thinking", label: t("activity.filter.thinking") },
    { value: "errors", label: t("activity.filter.errors") },
  ];

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Segmented ariaLabel={t("activity.filterLabel")} value={filter} options={filterOptions} onChange={setFilter} />
        <Input
          aria-label={t("activity.searchLabel")}
          placeholder={t("activity.searchLabel")}
          className="h-8 min-w-32 flex-1 text-[12px]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div ref={list} role="log" aria-label={t("activity.feedLabel")} className="min-w-0">
        {earlier && (
          <div className="pb-1 text-center">
            <Button
              size="sm"
              variant="ghost"
              loading={loadingEarlier}
              onClick={() => {
                prepended.current = scrollRoot?.scrollHeight ?? null;
                onLoadEarlier();
              }}
            >
              {t("activity.showEarlier")}
            </Button>
          </div>
        )}
        {shown.length === 0 && !tail ? (
          <p className="py-6 text-center text-[12px] text-[var(--ink-faint)]">
            {!loaded ? t("common.loading") : all.length > 0 ? t("activity.nothingMatches") : t("activity.empty")}
          </p>
        ) : (
          <ul className="space-y-1">
            {shown.map((row, i) => (
              <Row key={row.id} row={row} source={source} live={live} last={i === shown.length - 1} agent={agent} />
            ))}
            {tail && <li className="pt-1">{tail}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
