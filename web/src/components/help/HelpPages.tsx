import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { AboutPage } from "./AboutPage";
import { GuidePage } from "./GuidePage";

/** Help pages that open from the sidebar instead of the board. */
export type HelpPage = "about" | "guide";

interface Props {
  page: HelpPage;
  onPage: (page: HelpPage) => void;
  onClose: () => void;
  onAddProject: () => void;
}

/**
 * Help takes the whole main area rather than a modal: it is read for a long time,
 * scrolled and returned to by section, and a window over the board is inconvenient for that. The sidebar
 * stays in place — dispatcher, limits and events are visible from here too, and a click on a project
 * returns to its board.
 */
export function HelpPages({ page, onPage, onClose, onAddProject }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  // A new page starts from the top, not from the previous one's scroll position.
  useEffect(() => {
    scrollRef.current?.scrollTo?.(0, 0);
  }, [page]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
        <Segmented
          ariaLabel={t("pages.nav.helpNav")}
          value={page}
          onChange={onPage}
          options={[
            { value: "about", label: t("pages.nav.about") },
            { value: "guide", label: t("pages.nav.guide") },
          ]}
        />
        <Button variant="ghost" size="sm" icon={ArrowLeft} className="ml-auto" onClick={onClose}>
          {t("pages.nav.backToBoard")}
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {page === "about" ? (
          <AboutPage onOpenGuide={() => onPage("guide")} onAddProject={onAddProject} />
        ) : (
          <GuidePage />
        )}
      </div>
    </div>
  );
}
