import { useEffect, useRef, useState } from "react";
import { Eraser, ImagePlus, Trash2, X } from "lucide-react";
import { api } from "../api";
import { avatarFromFile, isAvatarImage, useAgents } from "../agents";
import type { Agent, AgentInput, AgentMemory, PermissionMode, Project } from "../types";
import { Modal } from "../ui/Modal";
import { Confirm } from "../ui/Confirm";
import { Button, IconButton } from "../ui/Button";
import { Field, Input, Select, Textarea, Toggle } from "../ui/Field";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { AgentAvatar } from "./AgentAvatar";
import { useTranslation } from "../i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null means creating a new agent. */
  agent: Agent | null;
  projects: Project[];
  /** Project preselected for a new internal agent. */
  defaultProjectId?: number | null;
  onSaved: () => void;
}

const PREVIEW_ID = 0;

function draftOf(agent: Agent | null, projectId: number | null): AgentInput {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    avatar: agent?.avatar ?? null,
    model: agent?.model ?? null,
    effort: agent?.effort ?? null,
    permission_mode: agent?.permission_mode ?? null,
    prompt: agent?.prompt ?? "",
    project_id: agent ? agent.project_id : projectId,
    memory_enabled: agent?.memory_enabled ?? false,
  };
}

/**
 * The projects the agent leads. Reads the same `lead_agent_id` as the project's own setting, so both
 * screens show one appointment. Who leads a project now is on the row: picking it replaces them.
 */
function LeadProjects({ agentId, projects, value, onChange }: { agentId: number | null; projects: Project[]; value: number[]; onChange: (next: number[]) => void }) {
  const { t } = useTranslation();
  const agents = useAgents();
  if (projects.length === 0) return null;
  return (
    <Field label={t("agents.form.leadLabel")} hint={t("agents.form.leadHint")}>
      <div role="group" aria-label={t("agents.form.leadLabel")} className="max-h-40 space-y-1 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
        {projects.map((p) => {
          const other = p.lead_agent_id !== agentId ? agents.find((a) => a.id === p.lead_agent_id) : undefined;
          return (
            <label key={p.id} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-[var(--ink)]">
              <input
                type="checkbox"
                checked={value.includes(p.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((id) => id !== p.id))}
              />
              <span className="truncate">{p.name}</span>{" "}
              {other &&<span className="ml-auto shrink-0 text-[11px] text-[var(--ink-faint)]">{t("agents.form.leadCurrent", { name: other.name })}</span>}
            </label>
          );
        })}
      </div>
    </Field>
  );
}

/** What the agent has saved for itself: read-only, since the sessions are its only writers. */
function MemoryFiles({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const [memory, setMemory] = useState<AgentMemory | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.agentMemory(agent.id).then((m) => !cancelled && setMemory(m)).catch(() => !cancelled && setMemory(null));
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  if (!memory) return null;
  return (
    <div className="space-y-1.5 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[12px] font-semibold text-[var(--ink-muted)]">{t("agents.form.memoryFilesHeading")}</h4>
        {memory.files.length > 0 && (
          <Button type="button" variant="ghost" size="sm" icon={Eraser} onClick={() => setConfirming(true)}>
            {t("agents.form.memoryClear")}
          </Button>
        )}
      </div>
      <p className="break-all font-mono text-[11px] text-[var(--ink-faint)]">{memory.path}</p>
      {memory.files.length === 0 ? (
        <p className="text-[12px] text-[var(--ink-faint)]">{t("agents.form.memoryEmpty")}</p>
      ) : (
        memory.files.map((file) => (
          <details key={file.name} className="text-[12px]">
            <summary className="cursor-pointer font-mono text-[var(--ink)]">{file.name}</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[var(--sunken)] p-2 font-mono text-[11px] text-[var(--ink-muted)]">
              {file.content}
              {file.truncated ? "\n…" : ""}
            </pre>
          </details>
        ))
      )}
      <Confirm
        open={confirming}
        title={t("agents.form.memoryClearTitle")}
        confirmLabel={t("agents.form.memoryClear")}
        confirmVariant="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void api.clearAgentMemory(agent.id).then(() => setMemory({ ...memory, files: [] }));
        }}
      >
        {t("agents.form.memoryClearBody")}
      </Confirm>
    </div>
  );
}

/**
 * Creating and editing an agent: identity, run parameters, the prompt, where it works, what it leads, memory.
 * The parent mounts the dialog per opening, so the draft always starts from the current agent.
 */
export function AgentDialog({ open, onOpenChange, agent, projects, defaultProjectId = null, onSaved }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AgentInput>(() => draftOf(agent, defaultProjectId));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [initialLeads] = useState(() => (agent ? projects.filter((p) => p.lead_agent_id === agent.id).map((p) => p.id) : []));
  const [leads, setLeads] = useState(initialLeads);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const image = isAvatarImage(draft.avatar);
  const visibleProjects = projects.filter((p) => !p.archived_at || p.id === draft.project_id);
  // An internal agent leads only its own project; an archived project takes no new lead but keeps its own
  const leadable = projects.filter((p) => (!p.archived_at || initialLeads.includes(p.id)) && (draft.project_id === null || p.id === draft.project_id));

  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      set("avatar", await avatarFromFile(file));
      setError(null);
    } catch {
      setError(t("agents.form.avatarError"));
    }
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      // Sent only when changed: the list is complete, so sending it would undo an appointment made
      // from a project's settings while this dialog was open.
      // Applied to the scope only here, so that trying another scope and coming back loses nothing.
      const kept = leads.filter((id) => leadable.some((p) => p.id === id));
      const leadsChanged = kept.length !== initialLeads.length || kept.some((id) => !initialLeads.includes(id));
      const body = leadsChanged ? { ...draft, lead_project_ids: kept } : draft;
      if (agent) await api.patchAgent(agent.id, body);
      else await api.addAgent(body);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!agent) return;
    setDeleting(false);
    setPending(true);
    setError(null);
    try {
      await api.deleteAgent(agent.id);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={agent ? t("agents.form.editTitle", { name: agent.name }) : t("agents.form.createTitle")}
      size="md"
      sticky
      footer={
        <div className="flex items-center justify-end gap-2">
          {agent && (
            <Button type="button" variant="ghost" icon={Trash2} className="mr-auto" onClick={() => setDeleting(true)} disabled={pending}>
              {t("common.delete")}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" loading={pending} disabled={!draft.name.trim()} onClick={() => void submit()}>
            {agent ? t("common.save") : t("agents.form.create")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <AgentAvatar agent={{ id: agent?.id ?? PREVIEW_ID, name: draft.name || "?", avatar: draft.avatar }} size={56} />
          <div className="min-w-0 flex-1 space-y-2.5">
            <Field label={t("agents.form.nameLabel")}>
              <Input
                autoFocus
                maxLength={60}
                placeholder={t("agents.form.namePlaceholder")}
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                aria-label={t("agents.form.avatarUpload")}
                onChange={(e) => {
                  void pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="secondary" size="sm" icon={ImagePlus} onClick={() => fileRef.current?.click()}>
                {t("agents.form.avatarUpload")}
              </Button>
              {!image && (
                <Input
                  className="h-7 w-24"
                  maxLength={4}
                  aria-label={t("agents.form.avatarGlyph")}
                  placeholder={t("agents.form.avatarGlyph")}
                  value={draft.avatar ?? ""}
                  onChange={(e) => set("avatar", e.target.value || null)}
                />
              )}
              {image && <IconButton icon={X} label={t("agents.form.avatarRemove")} size="sm" onClick={() => set("avatar", null)} />}
            </div>
          </div>
        </div>

        <Field label={t("agents.form.descriptionLabel")} hint={t("agents.form.descriptionHint")}>
          <Input
            maxLength={500}
            placeholder={t("agents.form.descriptionPlaceholder")}
            value={draft.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>

        <section className="space-y-2.5 rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2.5">
          <h3 className="text-[12px] font-semibold text-[var(--ink-muted)]">{t("agents.form.runHeading")}</h3>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
            <ModelPicker value={draft.model} defaultLabel={t("runParams.fromProject")} onChange={(v) => set("model", v)} />
            <EffortPicker value={draft.effort} defaultLabel={t("runParams.fromProject")} onChange={(v) => set("effort", v)} />
            <PermissionPicker
              value={draft.permission_mode}
              defaultLabel={t("runParams.fromProject")}
              onChange={(v: PermissionMode | null) => set("permission_mode", v)}
            />
          </div>
          <p className="text-[11px] leading-snug text-[var(--ink-faint)]">{t("agents.form.runHint")}</p>
        </section>

        <Field label={t("agents.form.promptLabel")} hint={t("agents.form.promptHint")}>
          <Textarea
            aria-label={t("agents.form.promptLabel")}
            className="min-h-28"
            maxLength={20000}
            placeholder={t("agents.form.promptPlaceholder")}
            value={draft.prompt}
            onChange={(e) => set("prompt", e.target.value)}
          />
        </Field>

        <Field label={t("agents.form.scopeLabel")} hint={t("agents.form.scopeHint")}>
          <Select
            aria-label={t("agents.form.scopeLabel")}
            value={draft.project_id ?? ""}
            onChange={(e) => set("project_id", e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t("agents.scopeEverywhere")}</option>
            {visibleProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <LeadProjects agentId={agent?.id ?? null} projects={leadable} value={leads} onChange={setLeads} />

        <Toggle
          checked={draft.memory_enabled}
          onChange={(v) => set("memory_enabled", v)}
          label={t("agents.form.memoryLabel")}
          hint={t("agents.form.memoryHint")}
        />
        {agent && draft.memory_enabled && <MemoryFiles agent={agent} />}

        {error && <p className="text-[12px] leading-snug text-[var(--danger)]">{error}</p>}
      </div>

      <Confirm
        open={deleting}
        title={t("agents.form.deleteTitle", { name: agent?.name ?? "" })}
        confirmLabel={t("common.delete")}
        confirmVariant="danger"
        onCancel={() => setDeleting(false)}
        onConfirm={() => void remove()}
      >
        {t("agents.form.deleteBody")}
      </Confirm>
    </Modal>
  );
}
