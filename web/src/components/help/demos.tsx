import type { CSSProperties, ReactNode } from "react";
import {
  CheckCircle2,
  Coins,
  FileText,
  FolderGit2,
  GitMerge,
  Hand,
  Inbox,
  Loader,
  MousePointer2,
  Plus,
  Send,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useTranslation, type TFunction } from "../../i18n";
import { BLOCKER_META, STATUS_META } from "../../status";
import { blockerLabel, stageLabel, statusLabel } from "../../labels";
import type { TaskStatus } from "../../types";
import { cn } from "../../lib/cn";
import { DemoPlayer } from "./DemoPlayer";

/*
 * Mini demo scenes. Each is a pure function of the frame number: the state is held by
 * DemoPlayer, and the scene only lays out elements. Motion is CSS transitions between
 * frames (left/top/opacity), so under prefers-reduced-motion the frames simply
 * switch without animation, and the demo stays understandable.
 *
 * Colors are the same status variables as on the board: the demo teaches reading the real
 * interface, not a separate "marketing" palette.
 */

/** Demo frame captions from the dictionary: pages.demos.<key>.captions.c1…cN. */
function captions(t: TFunction, key: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => t(`pages.demos.${key}.captions.c${i + 1}`));
}

const MOVE = "transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]";
const FADE = "transition-opacity duration-500";

/** Mini task card — the same anatomy as TaskCard: status stripe on the left, number, title, badge. */
function MiniCard({
  id,
  title,
  rail,
  badge,
  className,
  style,
}: {
  id: number;
  title: string;
  rail: string;
  badge?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        "relative overflow-hidden rounded-[6px] border border-[var(--line)] bg-[var(--surface)] py-1.5 pl-2.5 pr-1.5 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-[3px] transition-colors duration-500", rail)} />
      <p className="line-clamp-2 text-[11px] leading-tight text-[var(--ink)]">
        <span className="font-mono text-[10px] text-[var(--ink-faint)]">#{id} </span>
        {title}
      </p>
      <div className="mt-1 flex h-4 items-center gap-1">{badge}</div>
    </div>
  );
}

function Chip({ tone, icon: Icon, children }: { tone: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-[4px] px-1 text-[9.5px] font-medium leading-4", tone)}>
      {Icon && <Icon size={9} aria-hidden />}
      {children}
    </span>
  );
}

function Cursor({ style, visible }: { style: CSSProperties; visible: boolean }) {
  return (
    <MousePointer2
      size={16}
      aria-hidden
      style={style}
      className={cn(
        "pointer-events-none absolute z-10 fill-[var(--ink)] text-[var(--canvas)]",
        MOVE,
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

// ── A task's path across the board ───────────────────────────────────────────

const BOARD_COLUMNS: TaskStatus[] = ["backlog", "todo", "in_progress", "done"];
/** Frame → card column and its status (verification and merge live as a badge in "In progress"). */
const BOARD_PATH: { col: number; status: TaskStatus }[] = [
  { col: 0, status: "backlog" },
  { col: 1, status: "todo" },
  { col: 2, status: "in_progress" },
  { col: 2, status: "verifying" },
  { col: 2, status: "merging" },
  { col: 3, status: "done" },
];

/** Horizontal position within a grid of four columns with a 6px gap and 8px padding. */
const colLeft = (col: number) => `calc(8px + (100% - 34px) / 4 * ${col} + ${col * 6}px + 5px)`;
const COL_WIDTH = "calc((100% - 34px) / 4 - 10px)";

export function BoardScene({ step }: { step: number }) {
  const { t } = useTranslation();
  const { col, status } = BOARD_PATH[step];
  const meta = STATUS_META[status];
  const stage = stageLabel(t, status);

  let badge: ReactNode = null;
  if (status === "in_progress") badge = <Chip tone={meta.chip} icon={Loader}>{statusLabel(t, status)}</Chip>;
  else if (stage) badge = <Chip tone={meta.chip} icon={meta.icon}>{stage}</Chip>;
  else if (status === "done")
    badge = (
      <Chip tone="bg-[var(--sunken)] text-[var(--ink-muted)]" icon={Coins}>
        48k
      </Chip>
    );

  return (
    <div className="relative h-[200px] p-2">
      <div className="grid h-full grid-cols-4 gap-[6px]">
        {BOARD_COLUMNS.map((c) => (
          <div key={c} className="rounded-[7px] bg-[var(--sunken)]">
            <p className="flex items-center gap-1 truncate px-2 py-1.5 text-[10px] font-semibold text-[var(--ink-muted)]">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_META[c].dot)} />
              {statusLabel(t, c)}
            </p>
          </div>
        ))}
      </div>
      {/* The board neighbors sit lower — only our card moves */}
      <MiniCard
        id={38}
        title={t("pages.demos.input.otherCard")}
        rail={STATUS_META.backlog.rail}
        className="absolute top-[110px]"
        style={{ left: colLeft(0), width: COL_WIDTH }}
      />
      <MiniCard
        id={35}
        title={t("pages.demos.conflict.taskA")}
        rail={STATUS_META.done.rail}
        className="absolute top-[110px]"
        style={{ left: colLeft(3), width: COL_WIDTH }}
      />
      <MiniCard
        id={42}
        title={t("pages.demos.board.card")}
        rail={meta.rail}
        badge={badge}
        className={cn("absolute top-[38px]", MOVE, step === 1 && "rotate-[-1.5deg] shadow-[var(--shadow-pop)]")}
        style={{ left: colLeft(col), width: COL_WIDTH }}
      />
      <Cursor visible={step === 1} style={{ left: `calc(${colLeft(col)} + 40px)`, top: 58 }} />
    </div>
  );
}

export function BoardDemo() {
  const { t } = useTranslation();
  return (
    <DemoPlayer title={t("pages.demos.board.title")} captions={captions(t, "board", BOARD_PATH.length)}>
      {(step) => <BoardScene step={step} />}
    </DemoPlayer>
  );
}

// ── One dispatcher pass ──────────────────────────────────────────────────────

/** Pipeline nodes: label (except the queue — those are git and CLI names, they are not translated), icon, status color. */
const PIPELINE: { label?: string; icon: LucideIcon; tone: TaskStatus; line: string }[] = [
  { icon: Inbox, tone: "todo", line: "orc tick · slots 1/2 · #42 ← todo" },
  { label: "worktree", icon: FolderGit2, tone: "in_progress", line: "git worktree add .claude/worktrees/orc-task-42 -b orc/task-42 dev" },
  { label: "claude --bg", icon: SquareTerminal, tone: "in_progress", line: "claude --bg --permission-mode auto \"…\"" },
  { label: "report.json", icon: FileText, tone: "in_progress", line: "cat .orchestrator/report.json → {\"status\": \"success\"}" },
  { label: "verify_cmd", icon: ShieldCheck, tone: "verifying", line: "make test → 128 passed" },
  { label: "merge --no-ff", icon: GitMerge, tone: "merging", line: "git merge --no-ff orc/task-42 → dev" },
];

export function PipelineScene({ step }: { step: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-[230px] flex-col gap-2.5 p-3">
      <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {PIPELINE.map((node, i) => {
          const meta = STATUS_META[node.tone];
          const state = i < step ? "done" : i === step ? "active" : "idle";
          const Icon = state === "done" ? CheckCircle2 : node.icon;
          return (
            <li
              key={i}
              className={cn(
                "flex min-w-0 flex-col items-center gap-1 rounded-[7px] border px-1 py-2 text-center transition-all duration-500",
                state === "active"
                  ? "border-[var(--line-strong)] bg-[var(--surface)] shadow-[var(--shadow-pop)]"
                  : "border-transparent bg-[var(--sunken)]",
              )}
            >
              <Icon
                size={16}
                aria-hidden
                className={cn(
                  "transition-colors duration-500",
                  state === "idle" ? "text-[var(--ink-faint)]" : state === "done" ? "text-[var(--st-done)]" : meta.fg,
                  state === "active" && node.tone === "in_progress" && "animate-pulse",
                )}
              />
              <span
                className={cn(
                  "w-full truncate font-mono text-[9.5px]",
                  state === "idle" ? "text-[var(--ink-faint)]" : "text-[var(--ink)]",
                )}
              >
                {node.label ?? t("pages.demos.pipeline.queue")}
              </span>
            </li>
          );
        })}
      </ol>
      {/* Terminal: one line per frame, the last one is current */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-[7px] bg-[var(--sunken)] p-2 font-mono text-[10px] leading-[1.6]">
        {PIPELINE.slice(0, step + 1).map((node, i) => (
          <p
            key={i}
            className={cn("truncate", i === step ? "text-[var(--ink)]" : "text-[var(--ink-faint)]")}
          >
            <span className="text-[var(--ink-faint)]">$ </span>
            {node.line}
          </p>
        ))}
      </div>
    </div>
  );
}

export function PipelineDemo() {
  const { t } = useTranslation();
  return (
    <DemoPlayer title={t("pages.demos.pipeline.title")} captions={captions(t, "pipeline", PIPELINE.length)}>
      {(step) => <PipelineScene step={step} />}
    </DemoPlayer>
  );
}

// ── The agent asks ───────────────────────────────────────────────────────────

const INPUT_STEPS = 5;

export function InputScene({ step }: { step: number }) {
  const { t } = useTranslation();
  const waiting = step >= 1 && step <= 3;
  const windowOpen = step >= 2;
  const blocked = BLOCKER_META.needs_input;
  const progress = STATUS_META.in_progress;

  return (
    <div className="grid h-[230px] grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2 p-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        {/* The "Waiting for me" strip appears only while there is something that does not move without a human */}
        <div
          className={cn(
            "flex h-6 items-center gap-1 rounded-[6px] px-2 text-[10px] font-medium",
            FADE,
            blocked.chip,
            waiting ? "opacity-100" : "opacity-0",
          )}
        >
          <Hand size={10} aria-hidden />
          <span className="truncate">{t("topBar.waitingForMe")} · 1</span>
        </div>
        <div className="relative min-h-0 flex-1 rounded-[7px] bg-[var(--sunken)]">
          <p className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-semibold text-[var(--ink-muted)]">
            <span className={cn("h-1.5 w-1.5 rounded-full", progress.dot)} />
            {statusLabel(t, "in_progress")}
          </p>
          <MiniCard
            id={51}
            title={t("pages.demos.input.otherCard")}
            rail={progress.rail}
            badge={<Chip tone={progress.chip} icon={Loader}>{statusLabel(t, "in_progress")}</Chip>}
            className={cn("absolute inset-x-1.5", MOVE)}
            style={{ top: waiting ? 98 : 30 }}
          />
          <MiniCard
            id={57}
            title={t("pages.demos.input.card")}
            rail={waiting ? "bg-[var(--st-blocked)]" : progress.rail}
            badge={
              waiting ? (
                <Chip tone={blocked.chip} icon={Hand}>
                  {blockerLabel(t, "needs_input")}
                </Chip>
              ) : (
                <Chip tone={progress.chip} icon={Loader}>
                  {statusLabel(t, "in_progress")}
                </Chip>
              )
            }
            className={cn("absolute inset-x-1.5", MOVE, step === 2 && "ring-2 ring-[var(--focus)]")}
            style={{ top: waiting ? 30 : 98 }}
          />
        </div>
      </div>

      {/* Task modal: the agent's question on top, the answer field below */}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-1.5 rounded-[7px] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-pop)]",
          MOVE,
          windowOpen ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        )}
      >
        <p className="truncate text-[11px] font-semibold text-[var(--ink)]">
          <span className="font-mono text-[10px] font-normal text-[var(--ink-faint)]">#57 </span>
          {t("pages.demos.input.card")}
        </p>
        <div
          className={cn(
            "rounded-[6px] border px-2 py-1.5 text-[10.5px] leading-snug transition-colors duration-500",
            step === 4
              ? "border-[var(--line)] text-[var(--ink-muted)]"
              : "border-[color-mix(in_oklab,var(--st-blocked)_40%,transparent)] text-[var(--ink)]",
          )}
        >
          <p className={cn("mb-0.5 flex items-center gap-1 text-[9.5px] font-medium", step === 4 ? "text-[var(--ink-faint)]" : blocked.fg)}>
            <Hand size={9} aria-hidden />
            {t("taskModal.author.claude")}
          </p>
          {t("pages.demos.input.question")}
        </div>
        <div
          className={cn(
            "rounded-[6px] bg-[var(--sunken)] px-2 py-1.5 text-[10.5px] leading-snug text-[var(--ink)]",
            FADE,
            step === 4 ? "opacity-100" : "opacity-0",
          )}
        >
          <p className="mb-0.5 text-[9.5px] font-medium text-[var(--ink-faint)]">{t("taskModal.author.user")}</p>
          {t("pages.demos.input.reply")}
        </div>
        <div className="mt-auto">
          <p className="mb-0.5 text-[9.5px] font-medium text-[var(--ink-muted)]">{t("taskModal.answerLabel")}</p>
          <div className="flex items-center gap-1">
            <div
              className={cn(
                "h-6 min-w-0 flex-1 truncate rounded-[5px] border bg-[var(--sunken)] px-1.5 text-[10.5px] leading-6 text-[var(--ink)]",
                step === 3 ? "border-[var(--focus)]" : "border-[var(--line)]",
              )}
            >
              {step === 3 ? t("pages.demos.input.reply") : ""}
              {step === 3 && <span className="ml-px inline-block h-3 w-px translate-y-0.5 animate-pulse bg-[var(--ink)]" />}
            </div>
            <span
              className={cn(
                "flex h-6 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10px] font-medium",
                step === 3 ? "bg-[var(--primary)] text-[var(--primary-ink)]" : "bg-[var(--sunken)] text-[var(--ink-faint)]",
              )}
            >
              <Send size={9} aria-hidden />
              {t("taskModal.reply")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function InputDemo() {
  const { t } = useTranslation();
  return (
    <DemoPlayer title={t("pages.demos.input.title")} captions={captions(t, "input", INPUT_STEPS)}>
      {(step) => <InputScene step={step} />}
    </DemoPlayer>
  );
}

// ── A conflict returns to the author ─────────────────────────────────────────

const CONFLICT_STEPS = 6;
const LANE = { a: 40, dev: 96, b: 152 };

export function ConflictScene({ step }: { step: number }) {
  const { t } = useTranslation();
  // An element appears from its frame and then stays: this shows what was there before
  const from = (k: number): CSSProperties => ({ opacity: step >= k ? 1 : 0, transition: "opacity 500ms" });
  const branch = "var(--st-progress)";
  return (
    <div className="h-[200px] px-2 py-1">
      <svg viewBox="0 0 600 192" className="h-full w-full" role="presentation">
        <g fontFamily="'IBM Plex Mono', ui-monospace, monospace" fontSize="11" fill="var(--ink-faint)">
          <text x="4" y={LANE.a + 4}>orc/task-41</text>
          <text x="4" y={LANE.dev + 4} fill="var(--ink-muted)" fontWeight="600">dev</text>
          <text x="4" y={LANE.b + 4}>orc/task-42</text>
        </g>
        {/* Target branch */}
        <line x1="104" y1={LANE.dev} x2="590" y2={LANE.dev} stroke="var(--line-strong)" strokeWidth="2" />
        <circle cx="124" cy={LANE.dev} r="5" fill="var(--ink-faint)" />

        {/* Two tasks branched off one commit */}
        <path d={`M124 ${LANE.dev} C150 ${LANE.dev} 150 ${LANE.a} 176 ${LANE.a} H292`} fill="none" stroke={branch} strokeWidth="2" />
        <path d={`M124 ${LANE.dev} C150 ${LANE.dev} 150 ${LANE.b} 176 ${LANE.b} H300`} fill="none" stroke={branch} strokeWidth="2" />
        {[206, 256].map((x) => (
          <g key={x}>
            <circle cx={x} cy={LANE.a} r="5" fill="var(--surface)" stroke={branch} strokeWidth="2" />
            <circle cx={x} cy={LANE.b} r="5" fill="var(--surface)" stroke={branch} strokeWidth="2" />
          </g>
        ))}
        <text x="176" y={LANE.a - 14} fontSize="11" fill="var(--ink-muted)">#41 {t("pages.demos.conflict.taskA")}</text>
        <text x="176" y={LANE.b + 24} fontSize="11" fill="var(--ink-muted)">#42 {t("pages.demos.conflict.taskB")}</text>

        {/* #41 merges first */}
        <g style={from(1)}>
          <path d={`M292 ${LANE.a} C318 ${LANE.a} 318 ${LANE.dev} 344 ${LANE.dev}`} fill="none" stroke="var(--st-merging)" strokeWidth="2" />
          <circle cx="344" cy={LANE.dev} r="6" fill="var(--st-merging)" />
        </g>

        {/* #42 runs into someone else's changes */}
        <g style={from(2)}>
          <circle cx="300" cy={LANE.b} r="9" fill="var(--surface)" stroke="var(--warn)" strokeWidth="2" />
          <text x="300" y={LANE.b + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--warn)">!</text>
          <text x="316" y={LANE.b - 12} fontSize="11" fontWeight="600" fill="var(--warn)">{blockerLabel(t, "conflict")}</text>
        </g>

        {/* The target branch is merged into the task branch — in its worktree */}
        <g style={from(3)}>
          <path d={`M344 ${LANE.dev} C370 ${LANE.dev} 370 ${LANE.b} 396 ${LANE.b}`} fill="none" stroke="var(--ink-faint)" strokeWidth="2" strokeDasharray="4 3" />
          <path d={`M309 ${LANE.b} H396`} fill="none" stroke={branch} strokeWidth="2" />
          <circle cx="396" cy={LANE.b} r="6" fill="var(--surface)" stroke={branch} strokeWidth="2.5" />
        </g>

        {/* Verification again */}
        <g style={from(4)}>
          <path d={`M402 ${LANE.b} H444`} fill="none" stroke={branch} strokeWidth="2" />
          <circle cx="450" cy={LANE.b} r="7" fill="var(--st-verifying)" />
          <text x="450" y={LANE.b - 14} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--st-verifying)">
            {stageLabel(t, "verifying")} ✓
          </text>
        </g>

        {/* And the merge */}
        <g style={from(5)}>
          <path d={`M457 ${LANE.b} C482 ${LANE.b} 482 ${LANE.dev} 508 ${LANE.dev}`} fill="none" stroke="var(--st-merging)" strokeWidth="2" />
          <circle cx="508" cy={LANE.dev} r="7" fill="var(--st-done)" />
          <text x="508" y={LANE.dev - 14} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--st-done)">
            {statusLabel(t, "done")}
          </text>
        </g>
      </svg>
    </div>
  );
}

export function ConflictDemo() {
  const { t } = useTranslation();
  return (
    <DemoPlayer title={t("pages.demos.conflict.title")} captions={captions(t, "conflict", CONFLICT_STEPS)}>
      {(step) => <ConflictScene step={step} />}
    </DemoPlayer>
  );
}

// ── Adding a project ─────────────────────────────────────────────────────────

const PROJECT_STEPS = 5;

export function ProjectScene({ step }: { step: number }) {
  const { t } = useTranslation();
  const name = t("pages.demos.project.projectName");
  const dialogOpen = step >= 1 && step <= 3;
  // The field being filled on this frame is highlighted with focus; filled ones stay
  const fields: { label: string; value: string; from: number }[] = [
    { label: t("projectDialog.nameLabel"), value: name, from: 1 },
    { label: t("projectDialog.pathLabel"), value: `~/code/${name}`, from: 1 },
    { label: t("taskForm.verifyCmdLabel"), value: "make test", from: 2 },
    { label: t("projectDialog.maxWorkersLabel"), value: "2", from: 3 },
  ];

  return (
    <div className="relative grid h-[230px] grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] gap-2 p-2">
      <div className="min-w-0 rounded-[7px] border border-[var(--line)] bg-[var(--surface)] p-1.5">
        <div className="flex h-6 items-center px-1">
          <p className="truncate text-[10px] font-medium text-[var(--ink-faint)]">{t("sidebar.projectsHeading")}</p>
          <span
            className={cn(
              "ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[var(--ink-muted)] transition-shadow",
              step === 0 && "bg-[color-mix(in_oklab,var(--ink)_8%,transparent)] ring-2 ring-[var(--focus)]",
            )}
          >
            <Plus size={11} aria-hidden />
          </span>
        </div>
        <ul className="space-y-0.5 text-[11px]">
          {["backend", "docs"].map((p) => (
            <li key={p} className="truncate rounded-[5px] px-1.5 py-1 text-[var(--ink-muted)]">
              {p}
            </li>
          ))}
          <li
            className={cn(
              "relative truncate rounded-[5px] px-1.5 py-1",
              FADE,
              step === 4 ? "bg-[color-mix(in_oklab,var(--ink)_10%,transparent)] text-[var(--ink)] opacity-100" : "opacity-0",
            )}
          >
            <span className="absolute left-0 top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-r bg-[var(--ink)]" />
            {name}
          </li>
        </ul>
      </div>

      <div
        className={cn(
          "flex min-w-0 flex-col gap-1.5 rounded-[7px] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-pop)]",
          MOVE,
          dialogOpen ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        )}
      >
        <p className="truncate text-[11px] font-semibold text-[var(--ink)]">{t("projectDialog.newProjectTitle")}</p>
        {fields.map((f) => (
          <div key={f.label} className="min-w-0">
            <p className="truncate text-[9.5px] font-medium text-[var(--ink-muted)]">{f.label}</p>
            <div
              className={cn(
                "h-5 truncate rounded-[5px] border bg-[var(--sunken)] px-1.5 font-mono text-[10px] leading-[18px] text-[var(--ink)] transition-colors duration-300",
                step === f.from ? "border-[var(--focus)]" : "border-[var(--line)]",
              )}
            >
              <span className={cn(FADE, step >= f.from ? "opacity-100" : "opacity-0")}>{f.value}</span>
            </div>
          </div>
        ))}
        <span className="ml-auto mt-auto rounded-[5px] bg-[var(--primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary-ink)]">
          {t("common.save")}
        </span>
      </div>
      <Cursor visible={step === 0} style={{ left: "calc(37.5% - 18px)", top: 22 }} />
    </div>
  );
}

export function ProjectDemo() {
  const { t } = useTranslation();
  return (
    <DemoPlayer title={t("pages.demos.project.title")} captions={captions(t, "project", PROJECT_STEPS)}>
      {(step) => <ProjectScene step={step} />}
    </DemoPlayer>
  );
}
