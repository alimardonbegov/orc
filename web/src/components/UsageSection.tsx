import { Bot, Coins } from "lucide-react";
import type { TaskUsage, TokenCounters, UsageAgent } from "../types";
import { counterHint, counterLabel, formatCost, formatExact, formatTokens, subagentCount, usageCost } from "../usage";
import { cn } from "../lib/cn";
import { useTranslation, type TFunction, type Language } from "../i18n";

const COUNTER_KEYS: (keyof TokenCounters)[] = ["input", "cache_creation", "cache_read", "output"];

function agentName(t: TFunction, agent: UsageAgent): string {
  if (agent.agent_id === null) return t("usageSection.mainSession");
  return agent.agent_type ? t("usageSection.subagentNamed", { type: agent.agent_type }) : t("usageSection.subagent");
}

/** Number of subagents in words: Russian has three forms (1 / 2–4 / 5+), other languages two. */
function subagentsWord(t: TFunction, language: Language, count: number): string {
  if (language === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return t("usageSection.subagentRuOne");
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return t("usageSection.subagentRuFew");
    return t("usageSection.subagentRuMany");
  }
  return count === 1 ? t("usageSection.subagentOne") : t("usageSection.subagentOther");
}

/**
 * "Tokens" modal section: total, per-model table and agent list.
 * Table columns are the four API call counters as is, without "smart" sums:
 * cache reads and cache writes cost differently, and that is visible only separately.
 */
export function UsageSection({ usage, live }: { usage: TaskUsage; live?: boolean }) {
  const { t, language } = useTranslation();
  const models = Object.entries(usage.models);
  const subs = subagentCount(usage);
  const cost = usageCost(usage);
  // The section numbers sessions separately, so that subagents from the second resume show whose they are
  const sessionIndex = new Map(usage.sessions.map((s, i) => [s.session_id, i + 1]));
  const multiSession = usage.sessions.length > 1;

  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--sunken)] p-3">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ink)]">
        <Coins size={12} aria-hidden />
        {t("usageSection.heading")}
        <span className="tnum ml-auto font-mono text-[12px] font-medium" title={formatExact(usage.total_tokens)}>
          {formatTokens(usage.total_tokens)}
        </span>
      </h3>
      <p className="text-[11px] leading-relaxed text-[var(--ink-muted)]">
        {live ? t("usageSection.live") : ""}
        {multiSession ? t("usageSection.sessionsCount", { count: usage.sessions.length }) : ""}
        {subs > 0 ? t("usageSection.subagentsCount", { count: subs, word: subagentsWord(t, language, subs) }) : ""}
        {models.length === 1 ? t("usageSection.oneModel", { model: models[0][0] }) : t("usageSection.multiModels", { count: models.length })}.
        {cost && (
          <span title={cost.exact ? t("usageSection.costExactTitle") : t("usageSection.costEstimateTitle")}>
            {" "}≈ {formatCost(cost.amount)} {cost.exact ? t("usageSection.costExactSuffix") : t("usageSection.costEstimateSuffix")}
          </span>
        )}
      </p>

      <table className="tnum mt-2 w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr className="text-[var(--ink-faint)]">
            <th className="pb-1 text-left font-normal">{t("usageSection.modelHeader")}</th>
            {COUNTER_KEYS.map((k) => (
              <th key={k} className="pb-1 text-right font-normal" title={counterHint(t, k)}>{counterLabel(t, k)}</th>
            ))}
            <th className="pb-1 text-right font-normal">{t("usageSection.totalHeader")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map(([model, c]) => (
            <tr key={model} className="border-t border-[var(--line)]">
              <td className="max-w-[10rem] truncate py-1 pr-2 text-[var(--ink)]" title={t("usageSection.responses", { count: c.messages })}>{model}</td>
              {COUNTER_KEYS.map((k) => (
                <td key={k} className="py-1 pl-2 text-right text-[var(--ink-muted)]" title={formatExact(c[k])}>{formatTokens(c[k])}</td>
              ))}
              <td className="py-1 pl-2 text-right font-medium text-[var(--ink)]">
                {formatTokens(COUNTER_KEYS.reduce((sum, k) => sum + c[k], 0))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {usage.agents.length > 1 && (
        <ul className="mt-2 space-y-0.5 border-t border-[var(--line)] pt-2">
          {usage.agents.map((a, i) => (
            <li key={`${a.session_id}:${a.agent_id ?? "main"}:${i}`} className="flex items-baseline gap-1.5 text-[11px]">
              <Bot size={11} aria-hidden className={cn("relative top-px shrink-0", a.agent_id === null ? "text-[var(--ink)]" : "text-[var(--ink-faint)]")} />
              <span className={cn("shrink-0", a.agent_id === null ? "font-medium text-[var(--ink)]" : "text-[var(--ink-muted)]")}>
                {agentName(t, a)}
                {multiSession && a.session_id !== null && sessionIndex.has(a.session_id) ? t("usageSection.sessionSuffix", { n: sessionIndex.get(a.session_id) ?? 0 }) : ""}
              </span>
              {a.description && <span className="min-w-0 truncate text-[var(--ink-muted)]" title={a.description}>{a.description}</span>}
              <span className="ml-auto shrink-0 font-mono text-[var(--ink-faint)]">{a.model ?? "?"}</span>
              <span className="tnum shrink-0 font-mono font-medium text-[var(--ink)]" title={formatExact(a.total_tokens)}>
                {formatTokens(a.total_tokens)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
