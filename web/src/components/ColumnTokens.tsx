import { Coins } from "lucide-react";
import type { Task } from "../types";
import { formatExact, formatTokens, sumTokens } from "../usage";
import { useTranslation } from "../i18n";

/** Token total across the column's cards, in the "Done" header next to the counter. */
export function ColumnTokens({ tasks }: { tasks: Task[] }) {
  const { t } = useTranslation();
  const total = sumTokens(tasks);
  if (total <= 0) return null;
  return (
    <span
      className="tnum inline-flex items-center gap-1 font-mono text-[11px] text-[var(--ink-faint)]"
      title={t("columnTokens.title", { total: formatExact(total) })}
    >
      <Coins size={11} aria-hidden />
      {formatTokens(total)}
    </span>
  );
}
