import { useEffect, useState, type ComponentType } from "react";
import { Lightbulb, MapPin } from "lucide-react";
import { useTranslation } from "../../i18n";
import { focusRing } from "../../ui/tokens";
import { cn } from "../../lib/cn";
import { RichText } from "./RichText";
import { BoardDemo, ConflictDemo, InputDemo, PipelineDemo, ProjectDemo } from "./demos";

/**
 * Help sections in workflow order: from installation to the summary. Each has a number of steps
 * (keys s1…sN in the dictionary) and, where motion explains better than words, a mini demo.
 */
const SECTIONS: { key: string; steps: number; demo?: ComponentType }[] = [
  { key: "start", steps: 5 },
  { key: "project", steps: 8, demo: ProjectDemo },
  { key: "task", steps: 6, demo: BoardDemo },
  { key: "card", steps: 6 },
  { key: "dispatcher", steps: 6, demo: PipelineDemo },
  { key: "input", steps: 6, demo: InputDemo },
  { key: "problems", steps: 5, demo: ConflictDemo },
  { key: "finish", steps: 6 },
  { key: "branches", steps: 4 },
  { key: "overview", steps: 4 },
  { key: "settings", steps: 6 },
  { key: "hotkeys", steps: 0 },
];

/** Hotkeys — the same ones App handles (keydown) and dialogs (Esc). */
const HOTKEYS: { key: string; combo: string }[] = [
  { key: "n", combo: "N" },
  { key: "slash", combo: "/" },
  { key: "e", combo: "E" },
  { key: "d", combo: "D" },
  { key: "bracket", combo: "[" },
  { key: "question", combo: "?" },
  { key: "esc", combo: "Esc" },
];

const sectionId = (key: string) => `guide-${key}`;

/**
 * "How it works" — a step-by-step guide. A table of contents on the left (on a wide screen it
 * sticks to the edge and highlights the section currently being read), sections on the right:
 * where it is in the interface, what to do step by step, a demo and a tip.
 */
export function GuidePage() {
  const { t } = useTranslation();
  const g = (key: string) => t(`pages.guide.${key}`);
  const [current, setCurrent] = useState(SECTIONS[0].key);

  // Highlighting the current section in the table of contents. In the test environment (jsdom)
  // there is no IntersectionObserver — then the table of contents simply works without highlighting.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id.replace(/^guide-/, ""));
      },
      { rootMargin: "0px 0px -65% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(sectionId(s.key));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const jump = (key: string) => {
    setCurrent(key);
    // The page address is taken by the dashboard state (#p=…&t=…), so we scroll
    // to the section ourselves, not with an anchor link.
    document.getElementById(sectionId(key))?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mx-auto flex max-w-[1080px] gap-10 px-4 pb-16 pt-8 sm:px-8">
      <nav aria-label={g("tocLabel")} className="sticky top-6 hidden h-fit w-52 shrink-0 lg:block">
        <p className="mb-2 px-2 text-[11px] font-medium text-[var(--ink-faint)]">{g("tocLabel")}</p>
        <ol className="space-y-0.5">
          {SECTIONS.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => jump(s.key)}
                aria-current={current === s.key ? "location" : undefined}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-[12.5px] transition-colors duration-100",
                  focusRing,
                  current === s.key
                    ? "bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] text-[var(--ink)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink)]",
                )}
              >
                <span className="tnum w-4 shrink-0 text-[11px] text-[var(--ink-faint)]">{i + 1}</span>
                <span>{g(`sections.${s.key}.title`)}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <article className="min-w-0 max-w-[720px] flex-1">
        <header className="mb-10">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-[var(--ink)]">{g("title")}</h1>
          <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--ink-muted)]">{g("lead")}</p>
        </header>

        <div className="space-y-14">
          {SECTIONS.map((s, i) => {
            const k = (part: string) => g(`sections.${s.key}.${part}`);
            const Demo = s.demo;
            return (
              <section key={s.key} id={sectionId(s.key)} aria-labelledby={`${sectionId(s.key)}-title`} className="scroll-mt-6">
                <div className="flex items-baseline gap-2.5">
                  <span className="tnum text-[13px] font-semibold text-[var(--ink-faint)]">{String(i + 1).padStart(2, "0")}</span>
                  <h2 id={`${sectionId(s.key)}-title`} className="text-[19px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
                    {k("title")}
                  </h2>
                </div>
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--sunken)] px-2 py-1 text-[11.5px] text-[var(--ink-muted)]">
                  <MapPin size={12} aria-hidden className="shrink-0" />
                  <span className="font-medium text-[var(--ink-faint)]">{g("where")}:</span>
                  <span>{k("where")}</span>
                </p>
                <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--ink)]">
                  <RichText text={k("intro")} />
                </p>

                {s.steps > 0 && (
                  <ol className="mt-4 space-y-3">
                    {Array.from({ length: s.steps }, (_, n) => (
                      <li key={n} className="flex gap-3">
                        <span className="tnum mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] text-[10.5px] font-semibold text-[var(--ink-muted)]">
                          {n + 1}
                        </span>
                        <p className="min-w-0 text-[13px] leading-relaxed text-[var(--ink)]">
                          <RichText text={k(`steps.s${n + 1}`)} />
                        </p>
                      </li>
                    ))}
                  </ol>
                )}

                {s.key === "hotkeys" && (
                  <dl className="mt-4 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                    {HOTKEYS.map((h) => (
                      <div key={h.key} className="flex items-center gap-3 border-b border-[var(--line)] py-1.5">
                        <dt className="w-10 shrink-0">
                          <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[5px] border border-[var(--line-strong)] bg-[var(--surface)] px-1.5 font-mono text-[11px] text-[var(--ink)] shadow-[0_1px_0_var(--line-strong)]">
                            {h.combo}
                          </kbd>
                        </dt>
                        <dd className="text-[13px] text-[var(--ink)]">{k(`keys.${h.key}`)}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {Demo && (
                  <div className="mt-5">
                    <Demo />
                  </div>
                )}

                {s.key !== "hotkeys" && (
                  <aside className="mt-5 flex gap-2.5 rounded-[var(--radius)] border border-dashed border-[var(--line-strong)] px-3 py-2.5">
                    <Lightbulb size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-muted)]" />
                    <p className="text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                      <span className="font-semibold text-[var(--ink)]">{g("tip")}. </span>
                      <RichText text={k("tip")} />
                    </p>
                  </aside>
                )}
              </section>
            );
          })}
        </div>
      </article>
    </div>
  );
}
