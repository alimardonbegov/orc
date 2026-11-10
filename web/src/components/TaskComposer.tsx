import { useEffect, useRef, useState } from "react";
import { CheckCircle2, OctagonPause, PlayCircle, RotateCcw, Send, Square, StickyNote, type LucideIcon } from "lucide-react";
import { api, ApiError } from "../api";
import type { ActivitySource, ComposerMode } from "../activity";
import type { ActivityNow } from "../types";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Field";
import { useTranslation, type TFunction } from "../i18n";
import { filterQuickActions, quickActionSender, slashQuery, type QuickAction } from "../quickActions";
import { cn } from "../lib/cn";
import { DescriptionEditor } from "./DescriptionEditor";

interface Action {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost";
  title?: string;
}

interface Props {
  source: ActivitySource;
  mode: Exclude<ComposerMode, "request">;
  now: ActivityNow;
  draft: string;
  onDraft: (draft: string) => void;
  pending: boolean;
  /** Runs a command. Resolves true on success: then the draft is cleared. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  /** Starting the work: the card checks readiness and saves the description first. */
  startWork: (action: () => Promise<unknown>) => void;
  /** Stop the session, after the owner confirms it. */
  onStop: () => void;
  /** Close the card by hand, past verification and merge. Absent where there is no card to close. */
  onForceClose?: () => void;
  /** The canned messages offered under "/" in the field. */
  quickActions?: readonly QuickAction[];
}

function placeholder(t: TFunction, mode: Props["mode"], hasSession: boolean): string {
  switch (mode) {
    case "working":
    case "waiting_reply":
    case "sleeping":
    case "chat":
      return t("activity.replyPlaceholder");
    case "failed":
      return hasSession ? t("activity.continuePlaceholder") : t("activity.commentPlaceholder");
    case "done":
      return t("activity.composerPlaceholder");
    default:
      return t("activity.commentPlaceholder");
  }
}

/**
 * The one field of a conversation, at the bottom of the thread. What it sends follows the state of the card
 * (`composerMode`): a message to a live session, a rework of a finished one, a continuation of a stopped one,
 * and always a note, the one thing the agent never receives. Ctrl+Enter is the primary action.
 */
export function TaskComposer({ source, mode, now, draft, onDraft, pending, run, startWork, onStop, onForceClose, quickActions = [] }: Props) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const text = draft.trim();
  const id = source.id;

  // A question waits for the owner: the cursor is already where the answer goes. After the dialog takes
  // the focus on opening, and without scrolling: the card still opens on the task.
  useEffect(() => {
    if (mode !== "waiting_reply") return;
    const timer = window.setTimeout(() => box.current?.querySelector("textarea")?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [mode]);

  // "/" at the start of a single word opens the list of quick actions. Esc closes it for the text as it is;
  // typing on reopens it. The action goes the way the primary send does, and replaces the typed text.
  const query = slashQuery(draft);
  const sendAction = source.kind === "task" ? quickActionSender(mode, now, id) : null;
  const matches = query !== null && sendAction ? filterQuickActions(quickActions, query) : [];
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const menuOpen = query !== null && sendAction !== null && closedFor !== draft;
  useEffect(() => setActive(0), [query]);
  const choose = (action: QuickAction) => {
    if (!sendAction || pending) return;
    void run(() => sendAction(action.prompt)).then((ok) => {
      if (ok) onDraft("");
    });
  };

  const send = (action: () => Promise<unknown>) => {
    void run(action).then((ok) => {
      if (ok) onDraft("");
    });
  };

  const note = (primary: boolean): Action => ({
    key: "note",
    label: t("activity.composerNote"),
    icon: StickyNote,
    variant: primary ? "primary" : "ghost",
    title: t("activity.noteHint"),
    disabled: !text,
    onClick: () => send(() => api.addComment(id, text, "comment")),
  });
  const message: Action = {
    key: "send",
    label: t("activity.send"),
    icon: Send,
    variant: "primary",
    disabled: !text,
    onClick: () => send(() => api.addComment(id, text, "answer")),
  };
  const accept: Action = {
    key: "accept",
    label: t("activity.accept"),
    icon: CheckCircle2,
    title: t("activity.acceptHint"),
    // The page is read from disk and may be newer than the server that serves it: say so, not "Not Found"
    onClick: () =>
      void run(() =>
        api.acceptTask(id).catch((e: unknown) => {
          throw e instanceof ApiError && e.status === 404 ? new Error(t("activity.acceptOldServer")) : e;
        }),
      ),
  };
  const close: Action[] = onForceClose ? [{ key: "close", label: t("app.forceCloseConfirm"), icon: CheckCircle2, variant: "ghost", title: t("taskModal.stuckHint"), onClick: onForceClose }] : [];
  const retry = (primary: boolean): Action => ({
    key: "retry",
    label: t("taskModal.retry"),
    icon: RotateCcw,
    variant: primary ? "primary" : undefined,
    onClick: () => startWork(() => api.retry(id)),
  });

  let actions: Action[];
  let hint: string | null = null;
  switch (mode) {
    case "not_started":
      actions = [
        ...(now.status === "backlog"
          ? [{ key: "work", label: t("taskModal.toWork"), icon: PlayCircle, onClick: () => startWork(() => api.patchTask(id, { status: "todo" })) }]
          : []),
        note(true),
      ];
      break;
    case "working":
      hint = now.phase === "working" ? t("activity.replyHint") : null;
      actions = [
        note(false),
        { key: "stop", label: t("activity.stop"), icon: Square, variant: "danger", onClick: onStop },
        {
          key: "interrupt",
          label: text ? t("activity.interruptAndSend") : t("activity.interrupt"),
          icon: OctagonPause,
          // Esc, then whatever is in the field, like in a console. An empty field just interrupts.
          onClick: () => send(() => (text ? api.addComment(id, text, "answer", "interrupt") : api.interruptTask(id))),
        },
        message,
      ];
      break;
    case "waiting_reply":
      // The server takes the work only once nothing is on its way to the session
      actions = [note(false), ...(now.outbox_state ? [] : [accept]), message];
      break;
    case "sleeping":
      // No live session: a message resumes it now, ahead of its wakeup
      hint = t("activity.sleepingHint");
      actions = [note(false), { key: "stop", label: t("activity.stop"), icon: Square, variant: "danger", onClick: onStop }, accept, message];
      break;
    case "failed":
      actions = now.has_session
        ? [
            note(false),
            ...close,
            accept,
            retry(false),
            {
              key: "continue",
              label: text ? t("activity.continueWithMessage") : t("activity.continue"),
              icon: PlayCircle,
              variant: "primary",
              onClick: () => send(() => api.resume(id, text || undefined)),
            },
          ]
        : // No session ran (it failed to start, for example in an untrusted folder): there is no agent's work to accept
          [note(false), ...close, retry(true)];
      break;
    case "done":
      hint = t("taskModal.reworkHint");
      actions = [
        note(false),
        { key: "rework", label: t("taskModal.rework"), icon: RotateCcw, variant: "primary", disabled: !text, onClick: () => send(() => api.addComment(id, text, "rework")) },
      ];
      break;
    case "finishing":
      actions = [...close, note(true)];
      break;
    case "chat":
      actions = [
        { key: "stop", label: t("activity.stop"), icon: Square, variant: "danger", onClick: onStop },
        { ...message, onClick: () => send(() => api.sendChatMessage(id, text)) },
      ];
      break;
    default:
      actions = [note(true)];
  }
  const primary = actions.find((a) => a.variant === "primary" && !a.disabled);

  return (
    <div
      ref={box}
      data-testid="composer"
      className="space-y-1.5"
      onKeyDownCapture={(e) => {
        if (!menuOpen || e.target !== box.current?.querySelector("textarea")) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setClosedFor(draft);
        } else if (matches.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && matches.length > 0) {
          e.preventDefault();
          choose(matches[Math.min(active, matches.length - 1)]);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && primary && !pending) {
          e.preventDefault();
          primary.onClick();
        }
      }}
    >
      {menuOpen && (
        <div role="listbox" aria-label={t("card.quickActions.menu")} className="max-h-48 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--raised)] p-1 shadow-[var(--shadow-card)]">
          {matches.length === 0 && <p className="px-2 py-1 text-[12px] text-[var(--ink-faint)]">{t("card.quickActions.none")}</p>}
          {matches.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === active}
              title={a.prompt}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(a)}
              className={cn(
                "flex w-full cursor-pointer items-baseline gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-[12px] text-[var(--ink)]",
                i === active && "bg-[color-mix(in_oklab,var(--ink)_8%,transparent)]",
              )}
            >
              <span className="shrink-0 font-medium">/{a.title}</span>
              <span className="truncate text-[11px] text-[var(--ink-faint)]">{a.prompt}</span>
            </button>
          ))}
        </div>
      )}
      {source.kind === "task" ? (
        <DescriptionEditor
          label={t("activity.replyLabel")}
          placeholder={placeholder(t, mode, now.has_session)}
          textareaClassName="min-h-14 max-h-60 overflow-y-auto!"
          value={draft}
          onChange={onDraft}
        />
      ) : (
        <Textarea
          aria-label={t("activity.replyLabel")}
          placeholder={placeholder(t, mode, now.has_session)}
          className="min-h-14 text-[13px]"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
        />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {hint && <p className="min-w-40 flex-1 text-[11px] leading-snug text-[var(--ink-faint)]">{hint}</p>}
        {actions.map((a) => (
          <Button
            key={a.key}
            size="sm"
            variant={a.variant}
            icon={a.icon}
            title={a.title}
            disabled={pending || a.disabled}
            loading={pending && a.variant === "primary"}
            onClick={a.onClick}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
