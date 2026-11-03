import { Pause, Play, Timer, Zap } from "lucide-react";
import type { DispatcherStatus } from "../types";
import { Badge } from "../ui/Badge";
import { IconButton } from "../ui/Button";
import { Tip } from "../ui/Overlays";
import { cn } from "../lib/cn";
import { Campfire } from "../brand/glyphs";
import { useTranslation, type TFunction } from "../i18n";

interface Props {
  status: DispatcherStatus | null;
  onPause: () => void;
  onResume: () => void;
  onTick: () => void;
  /** A command was sent to the dispatcher: the buttons are waiting for the answer. */
  pending?: boolean;
  /** Collapsed rail: no labels, only the heartbeat and two buttons with tooltips remain. */
  collapsed?: boolean;
}

const time = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

/** Tooltip about passes: when the last one was, how long it took, how many steps failed. */
function tickHint(t: TFunction, locale: string, status: DispatcherStatus): string {
  if (!status.last_tick) return t("dispatcherPanel.noTicksYet");
  return (
    t("dispatcherPanel.lastTickAt", { time: time(status.last_tick, locale) }) +
    (status.last_tick_duration_sec !== null ? t("dispatcherPanel.tickDuration", { sec: status.last_tick_duration_sec.toFixed(1) }) : "") +
    (status.tick_error_count > 0 ? t("dispatcherPanel.tickErrors", { count: status.tick_error_count }) : "")
  );
}

/** Full tooltip: the status line shows only "running · 2 in progress"; everything else (pass time,
 * quota, checks) lives here. */
export function railHint(t: TFunction, locale: string, status: DispatcherStatus): string {
  const parts = [
    status.paused
      ? t("dispatcherPanel.pausedHint")
      : status.running > 0
        ? t("dispatcherPanel.workingHintRunning", { count: status.running })
        : t("dispatcherPanel.workingHintFree"),
    tickHint(t, locale, status),
  ];
  if (status.quota_retry_after) parts.push(t("dispatcherPanel.quotaUntil", { time: time(status.quota_retry_after, locale) }));
  if (status.verifying_now.length > 0) parts.push(t("dispatcherPanel.verifyingCount", { count: status.verifying_now.length }));
  // != null, not !== null: an SPA newer than the server (between make build and make restart) gets
  // undefined
  if (status.sessions_alive != null)
    parts.push(
      t("dispatcherPanel.sessionsLine", { alive: status.sessions_alive, reaped: status.reaped_total }) +
        (status.load_avg != null ? t("dispatcherPanel.loadSuffix", { load: status.load_avg.toFixed(1) }) : ""),
    );
  if (status.start_blocked_reason) parts.push(t("dispatcherPanel.startBlocked", { reason: status.start_blocked_reason }));
  return parts.join(". ");
}

/** Heartbeat: the only place where the phosphor colour glows. On pause it fades to grey. */
function Heartbeat({ status }: { status: DispatcherStatus | null }) {
  const working = status !== null && !status.paused && status.running > 0;
  return (
    <span
      aria-hidden
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status === null || status.paused ? "bg-[var(--ink-faint)]" : "bg-[var(--live)]",
        working && "orc-pulse",
      )}
    />
  );
}

/**
 * State of the whole orchestrator at the bottom of the left column: heartbeat, count of busy agents
 * and two commands: pause and an out-of-schedule pass.
 *
 * This used to be a block in the board header (DispatcherBar). But there is one dispatcher for all
 * projects, while the header is responsible for the current project; the place next to the limits
 * is more honest, and the board keeps its width for search and filters.
 */
export function DispatcherPanel({ status, onPause, onResume, onTick, pending, collapsed }: Props) {
  const { t, language } = useTranslation();
  const pauseLabel = status?.paused ? t("dispatcherPanel.resume") : t("dispatcherPanel.pause");
  const pauseHint = status?.paused ? t("dispatcherPanel.resumeHint") : t("dispatcherPanel.pauseHint");
  const controls = (
    <>
      <Tip side="right" text={pauseHint}>
        <IconButton
          icon={status?.paused ? Play : Pause}
          label={pauseLabel}
          size="sm"
          disabled={pending || status === null}
          className={collapsed ? "mx-auto flex" : ""}
          onClick={status?.paused ? onResume : onPause}
        />
      </Tip>
      <Tip side="right" text={t("dispatcherPanel.tickNowHint")}>
        <IconButton
          icon={Zap}
          label={t("dispatcherPanel.tickNow")}
          size="sm"
          disabled={pending || status === null}
          className={collapsed ? "mx-auto flex" : ""}
          onClick={onTick}
        />
      </Tip>
    </>
  );

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1">
        <Tip side="right" text={status ? railHint(t, language, status) : t("dispatcherPanel.notResponding")}>
          <span className="flex cursor-help flex-col items-center gap-0.5 py-0.5">
            <Heartbeat status={status} />
            {status && status.running > 0 && (
              <span className="tnum text-[9px] font-semibold leading-none text-[var(--ink-muted)]">{status.running}</span>
            )}
          </span>
        </Tip>
        {controls}
      </div>
    );
  }

  return (
    <div className="px-1">
      {/* One line for the whole state: heartbeat, word and count of busy agents on the left,
         commands on the right. The "Orchestrator" label moved into the tooltip: in the column
         footer a heading above a single line was a pure frame around two words. */}
      <div className="flex items-center gap-1.5">
        <Heartbeat status={status} />
        <Tip side="right" text={status ? railHint(t, language, status) : t("dispatcherPanel.noStateFromServer")}>
          <span className="flex min-w-0 cursor-help items-center gap-1 text-[11px] leading-none">
            <span className={cn("shrink-0", status === null ? "text-[var(--ink-faint)]" : "font-medium text-[var(--ink)]")}>
              {status === null ? t("dispatcherPanel.notResponding") : status.paused ? t("dispatcherPanel.pausedState") : t("dispatcherPanel.workingState")}
            </span>
            {status && (
              <span className="flex min-w-0 items-center gap-1 text-[var(--ink-muted)]">
                <span aria-hidden>·</span>
                {/* Campfire: the warband rests: the glyph appears exactly when nobody is
                   busy */}
                {status.running === 0 && <Campfire size={11} />}
                {/* "free" without a subject: next to the campfire and the heartbeat it is
                   clear who is meant, and the full "agents are free" did not fit in a line with
                   the buttons */}
                <span className="tnum truncate">{status.running > 0 ? t("dispatcherPanel.runningCount", { count: status.running }) : t("dispatcherPanel.free")}</span>
              </span>
            )}
          </span>
        </Tip>
        <span className="ml-auto flex shrink-0 items-center">{controls}</span>
      </div>

      {status && (status.quota_retry_after || status.verifying_now.length > 0 || status.start_blocked_reason) && (
        <div className="flex flex-wrap gap-1 pb-0.5 pt-1.5">
          {/* The load gate holds the start: without the badge tasks silently stood in "To
             do" while the reason lived only in the tooltip. The full text with numbers is in
             title, it does not fit in the line. */}
          {status.start_blocked_reason && (
            <Badge
              icon={Timer}
              tone="bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]"
              title={t("dispatcherPanel.startBlockedBadgeHint", { reason: status.start_blocked_reason })}
            >
              {t("dispatcherPanel.startBlockedBadge")}
            </Badge>
          )}
          {status.quota_retry_after && (
            <Badge icon={Timer} tone="bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-[var(--warn)]">
              {t("dispatcherPanel.quotaUntilBadge", { time: time(status.quota_retry_after, language) })}
            </Badge>
          )}
          {status.verifying_now.length > 0 && (
            <Badge icon={Timer}>{t("dispatcherPanel.verifyingBadge", { count: status.verifying_now.length })}</Badge>
          )}
        </div>
      )}
    </div>
  );
}
