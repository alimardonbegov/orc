import { useEffect, useState } from "react";
import { Download, File as FileIcon, FileImage, FileText } from "lucide-react";
import { api } from "../api";
import { useTranslation } from "../i18n";
import { cn } from "../lib/cn";
import type { Deliverable, DeliverableVersion, Task } from "../types";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { SidebarSection } from "../ui/SidebarSection";
import { focusRing } from "../ui/tokens";

/** Text files above this are offered as a download: the page is not an editor. */
const MAX_TEXT_PREVIEW = 512 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(file: DeliverableVersion) {
  if (file.mime.startsWith("image/")) return FileImage;
  return file.inline ? FileText : FileIcon;
}

/** "v2": shown only once a name has been handed in again. */
function VersionBadge({ version }: { version: number }) {
  return <span className="tnum rounded bg-[var(--raised)] px-1 text-[10.5px] text-[var(--ink-muted)]">v{version}</span>;
}

/**
 * Files the agent handed in as the card's result (`orc task attach`), after multica's deliverables: the section
 * stays out of the way until there is a file. Opening one shows an image or plain text in a window; every
 * other type, HTML and SVG included, is only offered as a download, because the file comes from an agent and
 * must never run on the origin of the control room (the server sends it with the same rule).
 */
export function DeliverablesSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<Deliverable[]>([]);
  const [opened, setOpened] = useState<{ name: string; version: number } | null>(null);

  // The card re-reads itself when the task changes; the files follow the same stamp.
  const stamp = `${task.updated_at}|${task.status}`;
  useEffect(() => {
    let current = true;
    api
      .taskDeliverables(task.id)
      .then((fresh) => {
        if (current) setFiles(Array.isArray(fresh) ? fresh : []);
      })
      .catch(() => {
        // Not control: a server older than this page has no such endpoint, and the card simply has no section.
      });
    return () => {
      current = false;
    };
  }, [task.id, stamp]);

  if (files.length === 0) return null;
  const group = opened ? files.find((f) => f.name === opened.name) : undefined;
  const version = group?.versions.find((v) => v.version === opened?.version) ?? group?.latest;

  return (
    <>
      <SidebarSection title={t("card.deliverables.heading")} count={files.length} defaultOpen>
        <ul className="space-y-0.5">
          {files.map((file) => {
            const Icon = iconFor(file.latest);
            return (
              <li key={file.name}>
                <button
                  type="button"
                  aria-label={t("card.deliverables.open", { name: file.name })}
                  onClick={() => setOpened({ name: file.name, version: file.latest.version })}
                  className={cn("flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left text-[12px] text-[var(--ink)] hover:bg-[var(--raised)]", focusRing)}
                >
                  <Icon size={13} aria-hidden className="shrink-0 text-[var(--ink-faint)]" />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  {file.versions.length > 1 && <VersionBadge version={file.latest.version} />}
                  <span className="tnum shrink-0 text-[11px] text-[var(--ink-faint)]">{formatSize(file.latest.size)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </SidebarSection>
      {group && version && (
        <Modal
          open
          onOpenChange={(open) => !open && setOpened(null)}
          title={group.name}
          subtitle={`${formatSize(version.size)} · ${t("card.deliverables.version", { n: version.version })}`}
          size="lg"
          actions={
            <a href={version.url} download={group.name} className="inline-flex">
              <Button size="sm" variant="ghost" icon={Download} tabIndex={-1}>
                {t("card.deliverables.download")}
              </Button>
            </a>
          }
        >
          {group.versions.length > 1 && (
            <div role="group" aria-label={t("card.deliverables.versions", { name: group.name })} className="mb-3 flex flex-wrap gap-1">
              {group.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={v.version === version.version}
                  onClick={() => setOpened({ name: group.name, version: v.version })}
                  className={cn(
                    "tnum cursor-pointer rounded border px-1.5 py-0.5 text-[11.5px]",
                    v.version === version.version ? "border-[var(--primary)] text-[var(--ink)]" : "border-[var(--line)] text-[var(--ink-muted)] hover:text-[var(--ink)]",
                    focusRing,
                  )}
                >
                  v{v.version}
                </button>
              ))}
            </div>
          )}
          <Preview file={version} />
          <p className="mt-3 text-[11.5px] text-[var(--ink-faint)]">{t("card.deliverables.note")}</p>
        </Modal>
      )}
    </>
  );
}

/** An image through <img>, text as text in a <pre>. Nothing is ever put into the page as markup. */
function Preview({ file }: { file: DeliverableVersion }) {
  const { t } = useTranslation();
  const isImage = file.inline && file.mime.startsWith("image/");
  const isText = file.inline && !isImage;
  const tooBig = isText && file.size > MAX_TEXT_PREVIEW;
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setText(null);
    setFailed(false);
    if (!isText || tooBig) return;
    let current = true;
    fetch(`${file.url}?inline=1`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => current && setText(body))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [file.id, file.url, isText, tooBig]);

  if (isImage) {
    return <img src={`${file.url}?inline=1`} alt={file.name} className="mx-auto max-h-[60vh] max-w-full rounded border border-[var(--line)]" />;
  }
  if (!isText || tooBig) {
    return <p className="text-[12.5px] text-[var(--ink-muted)]">{tooBig ? t("card.deliverables.tooBig") : t("card.deliverables.noPreview")}</p>;
  }
  if (failed) return <p className="text-[12.5px] text-[var(--danger)]">{t("card.deliverables.failed")}</p>;
  if (text === null) return <p className="text-[12.5px] text-[var(--ink-muted)]">{t("card.deliverables.loading")}</p>;
  return <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--line)] bg-[var(--raised)] p-3 text-[12px] leading-relaxed">{text}</pre>;
}
