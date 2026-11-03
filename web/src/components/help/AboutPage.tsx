import type { ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  Cloud,
  Coins,
  Eye,
  FileDiff,
  GitMerge,
  Hand,
  Inbox,
  LineChart,
  Minus,
  Plus,
  Rocket,
  ShieldCheck,
  Swords,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../../ui/Button";
import { OrcMark } from "../../brand/OrcMark";
import { cn } from "../../lib/cn";
import { RichText } from "./RichText";
import { BoardDemo } from "./demos";

/*
 * Dictionary key sets live here, not in the dictionary: t() returns only strings, and the order of
 * cards is the page's decision. A key without a translation would surface in the page test (HelpPages.test).
 */
const FLOW: { key: string; icon: LucideIcon }[] = [
  { key: "queue", icon: Inbox },
  { key: "work", icon: Bot },
  { key: "ship", icon: GitMerge },
];

const FEATURES: { key: string; icon: LucideIcon }[] = [
  { key: "dispatcher", icon: Rocket },
  { key: "verify", icon: ShieldCheck },
  { key: "merge", icon: GitMerge },
  { key: "conflict", icon: Swords },
  { key: "quota", icon: Timer },
  { key: "live", icon: Hand },
  { key: "cost", icon: Coins },
  { key: "summary", icon: LineChart },
];

const FOR_ITEMS = ["solo", "subscription", "local"];

const NOT_ITEMS: { key: string; icon: LucideIcon }[] = [
  { key: "multiAgent", icon: Users },
  { key: "diff", icon: FileDiff },
  { key: "cloud", icon: Cloud },
];

const LIMITS = ["local", "planMode", "quotaRegex", "delivery", "rework", "images", "autocommit", "stop"];

const RISKS = ["noHuman", "verifyEdited", "localRead"];

/** Idea status — how thought-through it is: a plan, a breakdown, or just a thought so far. */
const ROADMAP: { key: string; status: "plan" | "research" | "idea" }[] = [
  { key: "stop", status: "plan" },
  { key: "planMode", status: "research" },
  { key: "ide", status: "research" },
  { key: "windows", status: "idea" },
  { key: "review", status: "idea" },
  { key: "sessionLog", status: "idea" },
];

export function SectionHeading({ id, title, lead }: { id?: string; title: string; lead?: string }) {
  return (
    <div className="mb-4">
      <h2 id={id} className="text-[18px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
        {title}
      </h2>
      {lead && (
        <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-[var(--ink-muted)]">
          <RichText text={lead} />
        </p>
      )}
    </div>
  );
}

function Card({ icon: Icon, title, children, className }: { icon?: LucideIcon; title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] p-3.5", className)}>
      <p className="flex items-start gap-2 text-[13px] font-semibold leading-snug text-[var(--ink)]">
        {Icon && <Icon size={15} aria-hidden className="mt-px shrink-0 text-[var(--ink-muted)]" />}
        <span>{title}</span>
      </p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">{children}</p>
    </div>
  );
}

interface Props {
  onOpenGuide: () => void;
  onAddProject: () => void;
}

/**
 * "About" — a landing page inside the dashboard: what orc is, how it differs, who it is for
 * and, no less important, what it cannot do. Limitations, accepted risks and plans
 * are right here, not only in the README: they must be seen by a person deciding
 * whether to give orc a real repository.
 */
export function AboutPage({ onOpenGuide, onAddProject }: Props) {
  const { t } = useTranslation();
  const p = (key: string) => t(`pages.about.${key}`);

  return (
    <article className="mx-auto max-w-[960px] px-4 pb-16 pt-8 sm:px-8">
      {/* ── First screen ── */}
      <header className="grid items-center gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div>
          <OrcMark size={44} awake className="text-[var(--ink)]" />
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-faint)]">{p("eyebrow")}</p>
          <h1 className="mt-1.5 text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-[var(--ink)] sm:text-[32px]">
            {p("title")}
          </h1>
          <p className="mt-3 text-[13.5px] leading-relaxed text-[var(--ink-muted)]">
            <RichText text={p("lead")} />
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" size="lg" icon={BookOpen} onClick={onOpenGuide}>
              {p("ctaGuide")}
            </Button>
            <Button size="lg" icon={Plus} onClick={onAddProject}>
              {p("ctaAddProject")}
            </Button>
          </div>
        </div>
        <BoardDemo />
      </header>

      {/* ── Three steps ── */}
      <section className="mt-14" aria-labelledby="about-flow">
        <SectionHeading id="about-flow" title={p("flowHeading")} />
        <ol className="grid gap-2.5 md:grid-cols-3">
          {FLOW.map(({ key, icon: Icon }, i) => (
            <li key={key} className="relative rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] p-3.5">
              <div className="flex items-center gap-2">
                <span className="tnum flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sunken)] text-[11px] font-semibold text-[var(--ink)]">
                  {i + 1}
                </span>
                <Icon size={15} aria-hidden className="text-[var(--ink-muted)]" />
                <p className="text-[13px] font-semibold text-[var(--ink)]">{p(`flow.${key}.title`)}</p>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                <RichText text={p(`flow.${key}.body`)} />
              </p>
              {i < FLOW.length - 1 && (
                <ArrowRight
                  size={14}
                  aria-hidden
                  className="absolute -right-[13px] top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-[var(--canvas)] text-[var(--ink-faint)] md:block"
                />
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* ── Differences ── */}
      <section className="mt-14" aria-labelledby="about-features">
        <SectionHeading id="about-features" title={p("featuresHeading")} lead={p("featuresLead")} />
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ key, icon }) => (
            <Card key={key} icon={icon} title={p(`features.${key}.title`)}>
              <RichText text={p(`features.${key}.body`)} />
            </Card>
          ))}
        </div>
      </section>

      {/* ── Who it is for and what it is not ── */}
      <section className="mt-14 grid gap-8 md:grid-cols-2">
        <div>
          <SectionHeading title={p("forHeading")} />
          <ul className="space-y-2.5">
            {FOR_ITEMS.map((key) => (
              <li key={key} className="flex gap-2 text-[13px] leading-relaxed text-[var(--ink)]">
                <Check size={15} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-muted)]" />
                <span>
                  <RichText text={p(`forItems.${key}`)} />
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <SectionHeading title={p("notHeading")} lead={p("notLead")} />
          <ul className="space-y-2.5">
            {NOT_ITEMS.map(({ key, icon: Icon }) => (
              <li key={key} className="flex gap-2">
                <Icon size={15} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
                <p className="text-[13px] leading-relaxed">
                  <span className="font-semibold text-[var(--ink)]">{p(`notItems.${key}.title`)}.</span>{" "}
                  <span className="text-[var(--ink-muted)]">{p(`notItems.${key}.body`)}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Limitations ── */}
      <section className="mt-14" aria-labelledby="about-limits">
        <SectionHeading id="about-limits" title={p("limitsHeading")} lead={p("limitsLead")} />
        <ul className="grid gap-x-6 gap-y-4 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] p-4 sm:grid-cols-2 sm:p-5">
          {LIMITS.map((key) => (
            <li key={key} className="flex gap-2.5">
              <Minus size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--ink-faint)]" />
              <div>
                <p className="text-[13px] font-semibold leading-snug text-[var(--ink)]">{p(`limits.${key}.title`)}</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                  <RichText text={p(`limits.${key}.body`)} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Accepted risks ── */}
      <section className="mt-14" aria-labelledby="about-risks">
        <SectionHeading id="about-risks" title={p("risksHeading")} lead={p("risksLead")} />
        <div className="grid gap-2.5 md:grid-cols-3">
          {RISKS.map((key) => (
            <Card key={key} icon={Eye} title={p(`risks.${key}.title`)}>
              <RichText text={p(`risks.${key}.body`)} />
            </Card>
          ))}
        </div>
      </section>

      {/* ── What's next ── */}
      <section className="mt-14" aria-labelledby="about-roadmap">
        <SectionHeading id="about-roadmap" title={p("roadmapHeading")} lead={p("roadmapLead")} />
        <ul className="divide-y divide-[var(--line)] rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)]">
          {ROADMAP.map(({ key, status }) => (
            <li key={key} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <p className="shrink-0 text-[13px] font-semibold text-[var(--ink)] sm:w-48">{p(`roadmap.${key}.title`)}</p>
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                <RichText text={p(`roadmap.${key}.body`)} />
              </p>
              {/* An idea status is not a task status, so a neutral badge, no color */}
              <span
                className={cn(
                  "w-fit shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium",
                  status === "idea"
                    ? "border-dashed border-[var(--line-strong)] text-[var(--ink-faint)]"
                    : "border-[var(--line)] bg-[var(--sunken)] text-[var(--ink-muted)]",
                )}
              >
                {p(`roadmapStatus.${status}`)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-14 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--line)] pt-5 text-[12px] text-[var(--ink-faint)]">
        <OrcMark size={16} />
        <span>{p("footer")}</span>
        <a
          href="/brand/index.html"
          target="_blank"
          rel="noreferrer"
          className="text-[var(--ink-muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline"
        >
          {p("brandBook")}
        </a>
      </footer>
    </article>
  );
}
