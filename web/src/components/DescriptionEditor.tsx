import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { api } from "../api";
import {
  ACCEPT_MIME,
  checkImage,
  countImages,
  fileToBase64,
  imageMarker,
  imagesFrom,
  insertMarker,
} from "../attachments";
import { DescriptionView } from "./DescriptionView";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Field";
import { Segmented } from "../ui/Segmented";
import { cn } from "../lib/cn";
import { useTranslation } from "../i18n";

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Field label for the screen reader and for tests: there are two editors on a card. */
  label: string;
  className?: string;
  /** Field height: for an agent reply it is lower than for the task description. */
  textareaClassName?: string;
  autoFocus?: boolean;
}

type Mode = "text" | "preview";

/**
 * A text field into which an image can be pasted, just as in the Claude Code console: you write,
 * paste a screenshot, write on.
 *
 * The image goes into the text as a marker at the cursor position, so its place in the description
 * is the place where it was inserted. The "Preview" switch shows the result: in "Text" the marker
 * is visible (otherwise it could not be moved or deleted), in "Preview" the image itself.
 */
export function DescriptionEditor({ value, onChange, placeholder, label, className, textareaClassName, autoFocus }: Props) {
  const { t } = useTranslation();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("text");
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const images = countImages(value);

  /** Upload files one by one and place the markers in a row, keeping the selection order. */
  async function addImages(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setBusy((n) => n + files.length);
    // We keep the text locally: the caller's onChange is asynchronous (setState), and the second
    // image from the same batch would otherwise be inserted into the text without the first.
    let text = value;
    let caret = area.current?.selectionStart ?? value.length;
    for (const file of files) {
      const bad = checkImage(t, file);
      if (bad) {
        setError(bad);
        setBusy((n) => n - 1);
        continue;
      }
      try {
        const data = await fileToBase64(file);
        const saved = await api.uploadAttachment({ filename: file.name || t("descriptionEditor.imageFilename"), mime: file.type, data });
        const next = insertMarker(text, caret, imageMarker(saved.id, file.name || ""));
        text = next.text;
        caret = next.caret;
        onChange(text);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy((n) => n - 1);
      }
    }
    // Cursor after the last insertion, so one can keep writing right away
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-2">
        <Segmented
          ariaLabel={t("descriptionEditor.viewSwitch", { label })}
          value={mode}
          onChange={setMode}
          options={[
            { value: "text", label: t("descriptionEditor.textMode") },
            { value: "preview", label: t("descriptionEditor.previewMode") },
          ]}
        />
        <Button
          type="button"
          size="sm"
          icon={busy > 0 ? Loader2 : ImagePlus}
          onClick={() => picker.current?.click()}
          disabled={busy > 0}
        >
          {t("descriptionEditor.imageButton")}
        </Button>
        <input
          ref={picker}
          type="file"
          accept={ACCEPT_MIME.join(",")}
          multiple
          aria-label={t("descriptionEditor.pickImage")}
          className="hidden"
          onChange={(e) => {
            void addImages(Array.from(e.target.files ?? []));
            e.target.value = "";  // the same file must be selectable again
          }}
        />
        <span className="ml-auto text-[11px] text-[var(--ink-faint)]">
          {busy > 0 ? t("descriptionEditor.uploading") : images > 0 ? t("descriptionEditor.imageCount", { count: images }) : t("descriptionEditor.pasteHint")}
        </span>
      </div>

      {mode === "text" ? (
        <Textarea
          ref={area}
          className={cn("min-h-36", textareaClassName, dragging && "border-[var(--st-todo)]")}
          placeholder={placeholder}
          aria-label={label}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = imagesFrom(e.clipboardData);
            if (files.length === 0) return;   // plain text is pasted as usual
            e.preventDefault();
            void addImages(files);
          }}
          onDragOver={(e) => {
            if (imagesFrom(e.dataTransfer).length === 0) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            const files = imagesFrom(e.dataTransfer);
            setDragging(false);
            if (files.length === 0) return;
            e.preventDefault();
            void addImages(files);
          }}
        />
      ) : (
        <div className={cn("min-h-36 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] px-2.5 py-1.5", textareaClassName)}>
          {value.trim() ? (
            <DescriptionView text={value} />
          ) : (
            <p className="text-[12px] text-[var(--ink-faint)]">{t("descriptionEditor.emptyPreview")}</p>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--danger)]">{error}</p>}
    </div>
  );
}
