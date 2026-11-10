import { useState } from "react";
import { Archive, ArchiveRestore, MailOpen, MessageSquare, MoreHorizontal, Pencil, Pin, PinOff, Trash2, type LucideIcon } from "lucide-react";
import { api } from "../api";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import type { Chat } from "../types";
import { Popover } from "../ui/Overlays";
import { focusRing } from "../ui/tokens";

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: LucideIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] transition-colors duration-100",
        "hover:bg-[color-mix(in_oklab,var(--ink)_7%,transparent)]",
        danger ? "text-[var(--danger)]" : "text-[var(--ink)]",
        focusRing,
      )}
    >
      <Icon size={13} aria-hidden className="shrink-0" />
      {label}
    </button>
  );
}

interface Props {
  chat: Chat;
  /** The chat is on screen: it marks itself read again at once, so after "unread" or archiving it has to be left. */
  open: boolean;
  onChanged: () => void;
  onLeave: () => void;
  onRename: () => void;
  onDelete: () => void;
  onError: (message: string) => void;
  className?: string;
}

/**
 * The actions of a chat behind one "⋯" button: the same menu in the list row and in the conversation
 * header, so what the owner can do does not depend on which of the two he is looking at.
 */
export function ChatMenu({ chat, open, onChanged, onLeave, onRename, onDelete, onError, className }: Props) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const archived = !!chat.archived_at;

  const run = (action: () => Promise<unknown>, leave = false) => {
    setMenu(false);
    action()
      .then(() => {
        onChanged();
        if (leave) onLeave();
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Popover
      open={menu}
      onOpenChange={setMenu}
      align="end"
      className="w-52"
      trigger={
        <button
          type="button"
          aria-label={t("chats.list.actions")}
          title={t("chats.list.actions")}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-muted)] hover:bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] hover:text-[var(--ink)]",
            focusRing,
            className,
          )}
        >
          <MoreHorizontal size={15} aria-hidden />
        </button>
      }
    >
      <div className="flex flex-col p-1">
        <MenuItem
          icon={chat.pinned > 0 ? PinOff : Pin}
          label={chat.pinned > 0 ? t("chats.list.action.unpin") : t("chats.list.action.pin")}
          onClick={() => run(() => api.updateChat(chat.id, { pinned: chat.pinned === 0 }))}
        />
        {chat.unread > 0 ? (
          <MenuItem icon={MailOpen} label={t("chats.list.action.markRead")} onClick={() => run(() => api.markChatRead(chat.id))} />
        ) : (
          <MenuItem icon={MessageSquare} label={t("chats.list.action.markUnread")} onClick={() => run(() => api.markChatUnread(chat.id), open)} />
        )}
        <MenuItem
          icon={Pencil}
          label={t("chats.list.action.rename")}
          onClick={() => {
            setMenu(false);
            onRename();
          }}
        />
        <MenuItem
          icon={archived ? ArchiveRestore : Archive}
          label={archived ? t("chats.list.action.unarchive") : t("chats.list.action.archive")}
          onClick={() => run(() => api.updateChat(chat.id, { archived: !archived }), open && !archived)}
        />
        <MenuItem
          icon={Trash2}
          danger
          label={t("chats.list.action.delete")}
          onClick={() => {
            setMenu(false);
            onDelete();
          }}
        />
      </div>
    </Popover>
  );
}
