import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { api } from "../api";
import {
  ACCEPT_MIME,
  checkImage,
  countImages,
  fileToBase64,
  imageMarker,
  imagesFrom,
  imagesToUpload,
  insertMarker,
} from "../attachments";
import { DescriptionView } from "./DescriptionView";
import { Button } from "../ui/Button";
import { AutoGrowTextarea } from "../ui/Field";
import { textBox, textBoxBleed } from "../ui/tokens";
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
  /** Focus the field when it appears, without scrolling the page to it. */
  autoFocus?: boolean;
  /** Where the caret goes on that focus; the end of the text when absent. */
  initialCaret?: number;
  /** The least height of the field in px: what the text measured as a view, so a short text does not collapse. */
  minHeight?: number;
  /** Pull the field out by its own border and padding so that its text lines up with the text around it. */
  bleed?: boolean;
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
export function DescriptionEditor({
  value, onChange, placeholder, label, className, textareaClassName, autoFocus, initialCaret, minHeight, bleed,
}: Props) {
  const { t } = useTranslation();
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("text");
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const images = countImages(value);

  // Focus once, when the field appears. The `autoFocus` attribute would scroll the page to the field,
  // and in a long description clicked in the middle that is the very jump we are removing.
  const focusPlan = useRef({ autoFocus, initialCaret });
  useEffect(() => {
    const el = area.current;
    if (!focusPlan.current.autoFocus || !el) return;
    el.focus({ preventScroll: true });
    const at = Math.min(focusPlan.current.initialCaret ?? el.value.length, el.value.length);
    el.setSelectionRange(at, at);
  }, []);

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

  const floor = minHeight ? { minHeight } : undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      {mode === "text" ? (
        <AutoGrowTextarea
          ref={area}
          wrapperClassName={bleed ? textBoxBleed : undefined}
          className={cn("min-h-36", textareaClassName, dragging && "border-[var(--st-todo)]")}
          minHeight={minHeight}
          placeholder={placeholder}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = imagesToUpload(e.clipboardData);
            if (files.length === 0) return;   // text, even with a picture beside it, is pasted as usual
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
        <div
          className={cn(
            textBox,
            "min-h-36 rounded-[var(--radius-sm)] border-[var(--line)] bg-[var(--sunken)]",
            bleed && textBoxBleed,
            textareaClassName,
          )}
          style={floor}
        >
          {value.trim() ? (
            <DescriptionView text={value} plain />
          ) : (
            <p className="text-[12px] text-[var(--ink-faint)]">{t("descriptionEditor.emptyPreview")}</p>
          )}
        </div>
      )}

      {/* Under the field, not above it: a bar above would push the text down the moment the field opens. */}
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

      {error && <p className="text-[11px] text-[var(--danger)]">{error}</p>}
    </div>
  );
}
