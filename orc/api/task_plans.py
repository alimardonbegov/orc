"""Cards created by agents: a whole batch in one request, links between them, and what a caller needs to know.

The batch is all-or-nothing: an agent that got half a plan onto the board has no good way to find out
which half. A request carries a `cwd`, which says the project and the calling card, so that an agent
inside a worktree does not have to know any of it. See docs/agent-tasks.md.
"""
from __future__ import annotations

import sqlite3
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from orc import branches, card_settings, git_ops, projects, quick_create, stages, task_plans
from orc.api.common import (
    TARGET_BRANCH_EDITABLE, _check_agent, _check_deps, _check_parent, MAX_STAGE, _check_description_for_work, _check_window_open, _plan_or_400,
    _dispatcher, _repo, _task_detail,
)
from orc.api.tasks import _schedule_or_400
from orc.models import Priority, Project, Task, TaskStatus
from orc.task_plans import CycleError
from orc.util import utc_now

router = APIRouter()

# A repeated request is usually a session that lost the answer and asks again, soon. Much later the
# same text is more likely a new intention.
DEDUPE_WINDOW = timedelta(hours=24)
# In depends_on: the card whose worktree the request came from
CURRENT = "current"
CREATABLE_STATUSES = (TaskStatus.BACKLOG, TaskStatus.TODO)


class PlanDefaults(BaseModel):
    """What several cards of a batch have in common. extra=forbid everywhere here: a typo in a field
    name must come back as an error, not as a card that quietly runs with the wrong parameters."""
    model_config = ConfigDict(extra="forbid")
    status: str | None = None
    priority: str | None = None
    # An agent's name, or its id
    agent: str | int | None = None
    verify_cmd: str | None = None
    # Label names, created if missing. A card's own list replaces the default one.
    labels: list[str] | None = None


class PlanTask(PlanDefaults):
    # How other cards of this batch refer to this one
    ref: str | None = None
    title: str = Field(min_length=1)
    description: str = ""
    # A ref of this batch, the number of an existing card, or "current"
    depends_on: list[int | str] = []
    target_branch: str | None = None
    # Deferred start: ISO 8601 with a time zone (orc/schedule.py)
    start_after: str | None = None
    start_before: str | None = None
    # Planning days, YYYY-MM-DD: a plan for people, the dispatcher does not read them
    start_date: str | None = None
    due_date: str | None = None
    # The stage among the subtasks of the batch parent (orc/stages.py): it starts when the previous stage is done
    stage: int | None = None


class TaskPlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: int | None = None
    # A project's name or path
    project: str | None = None
    # The caller's folder: says the project when none is named, and the calling card
    cwd: str | None = None
    # The base of every card that does not name its own
    target_branch: str | None = None
    # Create target_branch from this branch if it does not exist yet
    create_target_from: str | None = None
    # Each card waits for the previous one, on top of its own depends_on
    sequential: bool = False
    # The card the new ones are subtasks of. Without it they are subtasks of the calling card, if any;
    # no_parent makes them top-level. Neither changes created_by_task_id, which the generation fuse walks.
    parent: int | None = None
    no_parent: bool = False
    defaults: PlanDefaults = PlanDefaults()
    tasks: list[PlanTask] = Field(min_length=1)
    idempotency_key: str | None = None


class DraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: int
    # The owner's own words
    text: str = Field(min_length=1, max_length=quick_create.MAX_TEXT_CHARS)
    # Overrides the quick_create_model setting for this one draft
    model: str | None = None


class LinksIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    add: list[int | str] = []
    remove: list[int] = []
    cwd: str | None = None


class MoveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # The project to move to: a name, an id or a path
    project: str | int
    # The base branch in the new project. Without it: the blockers' branch, then the project's base.
    target_branch: str | None = None
    # An agent of the new project, by name or id. Without it the current one stays if it fits there.
    agent: str | int | None = None
    cwd: str | None = None


def _live_projects(repo) -> list[Project]:
    return repo.list_projects(archived=False)


def _project_of_folder(request: Request, cwd: str | None) -> Project | None:
    """The project a folder belongs to. A chat outside any project has its scratch folder under the
    data directory, and that may well sit inside a clone of orc that is itself a project."""
    if not cwd:
        return None
    if Path(cwd).expanduser().resolve().is_relative_to(request.app.state.settings.data_dir.resolve()):
        return None
    return task_plans.project_from_path(_live_projects(_repo(request)), cwd)


def _resolve_project(request: Request, project_id: int | None, name: str | None, cwd: str | None) -> Project | None:
    """The named project, otherwise the one the caller stands in. None means nothing was named or
    found, and each caller decides what that means. A name that matches nothing is always an error."""
    repo = _repo(request)
    if project_id is not None:
        project = repo.get_project(project_id)
        if project is None:
            raise HTTPException(400, f"project #{project_id} not found")
        return project
    live = _live_projects(repo)
    if name:
        wanted = name.strip()
        matched = [p for p in live if p.name.casefold() == wanted.casefold()]
        if len(matched) > 1:
            raise HTTPException(400, f"several projects are named {wanted!r}: use the id: "
                                     + ", ".join(f"#{p.id} {p.path}" for p in matched))
        if matched:
            return matched[0]
        if wanted.isdigit():
            return _resolve_project(request, int(wanted), None, None)
        found = task_plans.project_from_path(live, wanted) if ("/" in wanted or wanted.startswith((".", "~"))) else None
        if found is None:
            raise HTTPException(400, f"project {wanted!r} not found. Projects: {_project_names(live)}")
        return found
    return _project_of_folder(request, cwd)


def _project_names(live: list[Project]) -> str:
    return ", ".join(f"{p.name} (#{p.id})" for p in live) or "none"


def _usable_project(request: Request, body: TaskPlanIn) -> Project:
    project = _resolve_project(request, body.project_id, body.project, body.cwd)
    if project is None:
        raise HTTPException(400, f"which project? The current folder belongs to none of them, so name one. "
                                 f"Projects: {_project_names(_live_projects(_repo(request)))}")
    try:
        projects.check_available(project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))
    return project


def _resolve_agent(repo, value: str | int | None, project_id: int) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, int):
        agent_id = value
    else:
        agent = repo.find_agent_by_name(value.strip())
        if agent is None:
            names = ", ".join(a.name for a in repo.list_agents(project_id)) or "none"
            raise HTTPException(400, f"agent {value!r} not found. Agents of this project: {names}")
        agent_id = agent.id
    _check_agent(repo, agent_id, project_id)
    return agent_id


def _caller_agent(repo, caller: Task | None, project_id: int) -> int | None:
    """The agent of the calling card, when a card of this project may use it."""
    agent = repo.get_agent(caller.agent_id) if caller is not None and caller.agent_id is not None else None
    return agent.id if agent is not None and agent.project_id in (None, project_id) else None


def _check_fuses(repo, caller: Task | None, count: int, statuses: list[str]) -> None:
    if count > task_plans.MAX_BATCH_TASKS:
        raise HTTPException(400, f"{count} cards in one batch, the limit is {task_plans.MAX_BATCH_TASKS}: "
                                 f"merge smaller steps into one card")
    if caller is None:
        return
    made = repo.count_created_by(caller.id)
    if made + count > task_plans.MAX_TASKS_PER_CALLER:
        raise HTTPException(400, f"card #{caller.id} has already created {made} cards, the limit is "
                                 f"{task_plans.MAX_TASKS_PER_CALLER}: stop and report to the owner instead")
    if TaskStatus.TODO in statuses and task_plans.generation(repo, caller) + 1 > task_plans.MAX_AUTOSTART_GENERATION:
        raise HTTPException(400, f"card #{caller.id} was itself created by a chain of agents, and this one would "
                                 f"run {task_plans.MAX_AUTOSTART_GENERATION + 1} generations deep: use status backlog, "
                                 f"so the owner decides whether it goes on")


def _validate_card(card: dict) -> tuple[str | None, str | None]:
    """Everything about one card that needs no other card. Returns the normalized schedule."""
    if not card["title"].strip():
        raise HTTPException(400, "title: must not be blank")
    if card["status"] not in CREATABLE_STATUSES:
        raise HTTPException(400, f"status: a new card can be {' or '.join(CREATABLE_STATUSES)}, got {card['status']!r}")
    if card["priority"] not in tuple(Priority):
        raise HTTPException(400, f"priority: expected one of {[p.value for p in Priority]}, got {card['priority']!r}")
    schedule_pair = _schedule_or_400(card["start_after"], card["start_before"])
    card["labels"], card["start_date"], card["due_date"] = _plan_or_400(card["labels"], card["start_date"], card["due_date"])
    if card["status"] == TaskStatus.TODO:
        _check_description_for_work(card["description"])
        _check_window_open(schedule_pair[1])
    return schedule_pair


def _split_deps(raw: list[int | str], refs: set[str], caller: Task | None) -> tuple[list[int], list[str]]:
    """depends_on → (ids of existing cards, refs of this batch). A digit string is a card number
    unless a ref has that name: agents write "12" as often as 12."""
    existing: list[int] = []
    local: list[str] = []
    for dep in raw:
        if isinstance(dep, str) and dep in refs:
            local.append(dep)
        elif dep == CURRENT:
            if caller is None:
                raise HTTPException(400, f"depends_on: {CURRENT!r} means the card this command runs in, "
                                         f"and this folder is not the worktree of any card")
            existing.append(caller.id)
        elif isinstance(dep, int) or dep.isdigit():
            existing.append(int(dep))
        else:
            raise HTTPException(400, f"depends_on: {dep!r} is neither a ref of this batch nor a card number. "
                                     f"Refs: {sorted(refs) or 'none'}")
    return existing, local


def _pick_target(card_label: str, explicit: str | None, inherited: set[str], fallback: str) -> str:
    """The base branch rule, see the module docstring of orc/task_plans.py."""
    if explicit:
        strangers = inherited - {explicit}
        if strangers:
            raise HTTPException(400, f"{card_label}: base branch {explicit}, but its blockers merge into "
                                     f"{', '.join(sorted(strangers))}: it would start without their work. "
                                     f"Put the whole chain on one branch")
        return explicit
    if len(inherited) > 1:
        raise HTTPException(400, f"{card_label}: its blockers merge into different branches "
                                 f"({', '.join(sorted(inherited))}), so no base can contain all of their work. "
                                 f"Put the whole chain on one branch")
    return next(iter(inherited), fallback)


def _warnings(cards: list[dict], created: list[Task], caller: Task | None, blockers: dict[int, Task]) -> list[str]:
    """What the caller should know about a request that was perfectly valid."""
    out: list[str] = []
    task_of = {id(card): task for card, task in zip(cards, created)}
    for card, task in zip(cards, created):
        if card.get("unassigned"):
            out.append(f"#{task.id}: no agent was named and the project has no default one, so the card stays in "
                       f"the backlog: without an assignee it cannot go to work")
        waits_for = [blockers[i] for i in card["existing"]] + [task_of[id(c)] for c in card["local_cards"]]
        for blocker in waits_for:
            if blocker.archived_at is not None:
                out.append(f"#{task.id}: blocker #{blocker.id} is archived, and an archived card does not hold anything: "
                           f"#{task.id} will not wait for it")
            elif blocker.status == TaskStatus.FAILED:
                out.append(f"#{task.id}: blocker #{blocker.id} has failed: #{task.id} waits until it is fixed")
            elif blocker.status == TaskStatus.BACKLOG and task.status == TaskStatus.TODO:
                out.append(f"#{task.id}: blocker #{blocker.id} is in the backlog and will not start by itself, "
                           f"so #{task.id} waits for the owner")
    roots = [t for card, t in zip(cards, created) if not card["existing"] and not card["local_cards"]]
    if caller is not None and roots and all(t.project_id == caller.project_id for t in roots):
        out.append(f"{_ids(roots)} do not wait for your card #{caller.id}: they start from {roots[0].target_branch} "
                   f"without your unmerged work. If they need it, add \"{CURRENT}\" to their depends_on")
    return out


def _ids(tasks: list[Task]) -> str:
    return ", ".join(f"#{t.id}" for t in tasks)


def _card_out(task: Task, repo, ref: str | None = None) -> dict:
    return {"id": task.id, "ref": ref, "title": task.title, "status": task.status, "target_branch": task.target_branch,
            "agent_id": task.agent_id, "depends_on": repo.deps_of(task.id), "parent_task_id": task.parent_task_id,
            "stage": task.stage,
            "labels": [item["name"] for item in repo.labels_of(task.id)]}


@router.post("/tasks/batch", status_code=201)
def add_batch(body: TaskPlanIn, request: Request):
    repo = _repo(request)
    project = _usable_project(request, body)
    if body.idempotency_key:
        since = (utc_now() - DEDUPE_WINDOW).isoformat()
        earlier = repo.tasks_by_batch_key(project.id, body.idempotency_key, since)
        if earlier:
            return {"project_id": project.id, "duplicate": True, "warnings": [],
                    "created": [_card_out(t, repo) for t in earlier]}

    caller = task_plans.find_caller(repo.list_tasks(archived=False), body.cwd)
    shared = body.defaults.model_dump()
    cards: list[dict] = []
    for raw in body.tasks:
        own = raw.model_dump(exclude_unset=True)
        card = {**shared, "ref": None, "description": "", "depends_on": [], "target_branch": None,
                "start_after": None, "start_before": None, "start_date": None, "due_date": None, "stage": None, **own}
        card["status"] = card["status"] or TaskStatus.BACKLOG
        card["priority"] = card["priority"] or Priority.NORMAL
        cards.append(card)

    refs = [c["ref"] for c in cards if c["ref"] is not None]
    if CURRENT in refs:
        raise HTTPException(400, f"ref: {CURRENT!r} is reserved for the card this command runs in")
    if len(refs) != len(set(refs)):
        raise HTTPException(400, f"ref: duplicates in {refs}")
    _check_fuses(repo, caller, len(cards), [c["status"] for c in cards])

    # Links: positions in the batch from here on, because not every card has a ref
    position = {c["ref"]: i for i, c in enumerate(cards) if c["ref"] is not None}
    edges: dict[int, list[int]] = {}
    for i, card in enumerate(cards):
        card["existing"], local = _split_deps(card["depends_on"], set(refs), caller)
        edges[i] = [position[r] for r in local]
        if body.sequential and i > 0:
            edges[i].append(i - 1)
    if any(i in edges[i] for i in edges):  # before the ring check: a ring of one is a different mistake to fix
        raise HTTPException(400, "depends_on: a card cannot wait for itself")
    try:
        order = task_plans.topological_order(edges)
    except CycleError:
        raise HTTPException(400, "depends_on: the cards of this batch wait for each other in a ring, none would ever start")

    if body.parent is not None and body.no_parent:
        raise HTTPException(400, "parent and no_parent: pick one")
    _check_parent(repo, body.parent)
    parent_id = None if body.no_parent else body.parent if body.parent is not None else caller.id if caller is not None else None

    _check_deps(repo, [d for c in cards for d in c["existing"]])
    _check_batch_stages(repo, cards, edges, parent_id)
    blockers = {d: repo.get_task(d) for c in cards for d in c["existing"]}

    path = Path(project.path)
    try:
        known = set(git_ops.list_branches(path))
        project_base = branches.base_branch(project, git_ops.current_branch(path))
    except git_ops.GitError as e:
        raise HTTPException(400, f"cannot read the project branches: {e}")
    if body.create_target_from and not body.target_branch:
        raise HTTPException(400, "create_target_from: says what to create target_branch from, and target_branch is not set")
    new_branch = body.target_branch if body.create_target_from and body.target_branch not in known else None
    if new_branch and body.create_target_from not in known:
        raise HTTPException(400, f"create_target_from: branch {body.create_target_from} does not exist in the repository")
    usable = known | ({new_branch} if new_branch else set())
    # A follow-up of a running card belongs where that card merges, not wherever the project happens to point
    fallback = (caller.target_branch if caller is not None and caller.project_id == project.id else None) or project_base

    rows: list[dict] = []
    links: list[tuple[list[int], list[int]]] = []
    placed: dict[int, int] = {}  # position in the batch → position in rows
    ordered_cards: list[dict] = []
    for i in order:
        card = cards[i]
        label = f"card {card['title']!r}"
        after, before = _validate_card(card)
        inherited = task_plans.same_project_branches([blockers[d] for d in card["existing"]], project.id)
        inherited |= {rows[placed[j]]["target_branch"] for j in edges[i]}
        target = _pick_target(label, card["target_branch"] or body.target_branch, inherited, fallback)
        if target not in usable:
            raise HTTPException(400, f"{label}: branch {target} does not exist in the repository. "
                                     f"To create it for this batch, set create_target_from")
        agent_id = _resolve_agent(repo, card["agent"], project.id)
        if card["status"] == TaskStatus.TODO and agent_id is None:
            # Only an agent's card goes to work. A session that named none means "whoever works here":
            # the project's default, otherwise its own agent. With neither, the card waits for the owner.
            agent_id = card_settings.default_agent(repo, project) or _caller_agent(repo, caller, project.id)
            if agent_id is None:
                card["status"] = TaskStatus.BACKLOG
                card["unassigned"] = True
        rows.append({
            "project_id": project.id, "title": card["title"].strip(), "description": card["description"],
            "status": str(card["status"]), "priority": str(card["priority"]), "target_branch": target,
            "verify_cmd": card["verify_cmd"], "agent_id": agent_id,
            "start_after": after, "start_before": before,
            "start_date": card["start_date"], "due_date": card["due_date"],
            "created_by_task_id": caller.id if caller is not None else None, "parent_task_id": parent_id,
            "stage": card["stage"],
            "batch_key": body.idempotency_key,
        })
        links.append((card["existing"], [placed[j] for j in edges[i]]))
        card["local_cards"] = [cards[j] for j in edges[i]]
        placed[i] = len(rows) - 1
        ordered_cards.append(card)

    # Last of all: a refusal above must leave nothing behind, and a branch is harder to take back than a row
    if new_branch:
        try:
            branches.create(repo, project, new_branch, body.create_target_from)
        except branches.BranchError as e:
            raise HTTPException(400, str(e))
    try:
        created = repo.add_task_graph(rows, links, labels=[c["labels"] or [] for c in ordered_cards])
    except sqlite3.IntegrityError as e:
        raise HTTPException(409, f"a blocker was deleted while the batch was being created, nothing was created: {e}")

    source = f"by card #{caller.id}" if caller is not None else "by an agent or the CLI"
    for task in created:
        repo.add_event(f"#{task.id} created {source}", task_id=task.id, project_id=project.id)
    return {
        "project_id": project.id, "duplicate": False,
        "warnings": _warnings(ordered_cards, created, caller, blockers),
        "created": [_card_out(t, repo, c["ref"]) for c, t in zip(ordered_cards, created)],
    }


@router.post("/tasks/draft")
def draft_task(body: DraftIn, request: Request):
    """A card written by a cheap model from the owner's words. Nothing is created: the answer fills the form,
    the owner edits it, and the usual POST /api/tasks makes the card. The tokens are logged to the spending ledger.
    A failure is a 502 whose message the form shows next to the text it keeps."""
    repo = _repo(request)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "text: describe the card in a few words")
    project = repo.get_project(body.project_id)
    if project is None:
        raise HTTPException(400, f"project #{body.project_id} not found")
    model = (body.model or repo.get_setting("quick_create_model") or quick_create.DEFAULT_MODEL).strip()
    if not quick_create.MODEL_RE.match(model):
        raise HTTPException(400, f"model: {model!r} is not a model id")
    try:
        projects.check_available(project)
        view = branches.overview(repo, project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))
    except git_ops.GitError as e:
        raise HTTPException(400, f"cannot read the project branches: {e}")
    agents = [{"id": a.id, "name": a.name, "description": a.description} for a in repo.list_agents(project.id)]
    settings = request.app.state.settings
    drafter = request.app.state.drafter
    cwd = settings.data_dir if settings.data_dir.is_dir() else None
    try:
        run = drafter(quick_create.build_prompt(text, agents, view["branches"], view["base"]),
                      quick_create.SYSTEM_PROMPT, model, cwd)
    except quick_create.DraftError as e:
        raise HTTPException(502, str(e))
    if run.tokens or run.cost_usd:
        repo.add_usage_entry(None, project.id, run.tokens, run.cost_usd)
    try:
        draft, warnings = quick_create.parse_draft(run.text, agents, view["branches"])
    except quick_create.DraftError as e:
        raise HTTPException(502, str(e))
    return {"draft": draft, "warnings": warnings,
            "usage": {"model": model, "tokens": run.tokens, "cost_usd": run.cost_usd}}


@router.post("/tasks/{task_id}/dependencies")
def change_links(task_id: int, body: LinksIn, request: Request):
    """Add or remove blockers of an existing card. PATCH replaces the whole list, and an agent that
    read it a minute ago would quietly drop whatever the owner has added since."""
    repo = _repo(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    if task.status not in TARGET_BRANCH_EDITABLE:
        raise HTTPException(400, f"card #{task_id} is {task.status}: it has already started, and a new blocker would change nothing")
    caller = task_plans.find_caller(repo.list_tasks(archived=False), body.cwd)
    added, _ = _split_deps(body.add, set(), caller)
    deps = [d for d in repo.deps_of(task_id) if d not in body.remove]
    deps += [d for d in added if d not in deps]
    _check_deps(repo, deps, task_id)
    fresh = [repo.get_task(d) for d in added]
    strangers = task_plans.same_project_branches(fresh, task.project_id) - {task.target_branch}
    if strangers:
        raise HTTPException(400, f"card #{task_id} has base branch {task.target_branch}, but the new blockers merge into "
                                 f"{', '.join(sorted(strangers))}: it would start without their work. "
                                 f"Move it to their branch first")
    repo.set_deps(task_id, deps)
    return _task_detail(repo, repo.get_task(task_id))


@router.post("/tasks/{task_id}/move")
def move_task(task_id: int, body: MoveIn, request: Request):
    """Move a card that has not started to another project. The base branch and the agent are chosen
    for the new repository here, and the dispatcher makes the move under its lock."""
    repo, dispatcher = _repo(request), _dispatcher(request)
    task = repo.get_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    wanted = str(body.project)
    project = _resolve_project(request, None, wanted, body.cwd)
    if project is None:
        raise HTTPException(400, f"which project? Projects: {_project_names(_live_projects(repo))}")
    if project.id == task.project_id:
        raise HTTPException(400, f"card #{task_id} is already in project {project.name}")
    try:
        projects.check_available(project)
    except projects.ProjectPathError as e:
        raise HTTPException(409, str(e))

    warnings: list[str] = []
    if body.agent is not None:
        agent_id = _resolve_agent(repo, body.agent, project.id)
    else:
        current = repo.get_agent(task.agent_id) if task.agent_id is not None else None
        if current is None or current.project_id in (None, project.id):
            agent_id = current.id if current is not None else None
        else:
            agent_id = card_settings.default_agent(repo, project)
            warnings.append(f"agent {current.name!r} belongs to the old project: "
                            + (f"the card now has the default agent of {project.name}" if agent_id is not None
                               else f"the card has no agent now"))
    if agent_id is None and task.status == TaskStatus.TODO:
        warnings.append(f"card #{task_id} has no agent, so it went back to the backlog: assign one to send it to work")

    path = Path(project.path)
    try:
        known = set(git_ops.list_branches(path))
        base = branches.base_branch(project, git_ops.current_branch(path))
    except git_ops.GitError as e:
        raise HTTPException(400, f"cannot read the project branches: {e}")
    inherited = task_plans.same_project_branches([repo.get_task(d) for d in repo.deps_of(task_id)], project.id)
    target = _pick_target(f"card #{task_id}", body.target_branch, inherited, base)
    if target not in known:
        raise HTTPException(400, f"branch {target} does not exist in project {project.name}. Name another with target_branch")
    # Cards of the new project that wait for this one see its work only on the same branch
    dependents = [d for d in map(repo.get_task, repo.dependents_of(task_id)) if d is not None and d.status != TaskStatus.DONE and d.archived_at is None]
    strangers = [d for d in dependents if d.project_id == project.id and d.target_branch != target]
    if strangers:
        raise HTTPException(400, f"{_ids(strangers)} in {project.name} wait for card #{task_id} but merge into other branches "
                                 f"than {target}: they would start without its work. Move the chain together")

    try:
        moved = dispatcher.move_task(task_id, project.id, target, agent_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    left_behind = [d for d in dependents if d.project_id != project.id]
    if left_behind:
        warnings.append(f"{_ids(left_behind)} still wait for card #{task_id}, now in another project: only the order "
                        f"applies between projects, they will not get its work")
    return {**_task_detail(repo, moved), "warnings": warnings}


@router.get("/tasks/context")
def plan_context(request: Request, project: str | None = None, cwd: str | None = None):
    """Everything an agent needs before planning cards, in one read: where it stands and what it can use."""
    repo = _repo(request)
    found = _resolve_project(request, None, project, cwd)
    caller = task_plans.find_caller(repo.list_tasks(archived=False), cwd)
    out: dict = {
        "projects": [{"id": p.id, "name": p.name, "path": p.path} for p in _live_projects(repo)],
        "project": None, "caller": None,
    }
    if caller is not None:
        out["caller"] = {"id": caller.id, "title": caller.title, "target_branch": caller.target_branch,
                         "project_id": caller.project_id}
    if found is None:
        return out
    out["project"] = {"id": found.id, "name": found.name, "path": found.path}
    try:
        projects.check_available(found)
        view = branches.overview(repo, found)
        out["base_branch"], out["branches"] = view["base"], view["branches"]
    except (projects.ProjectPathError, git_ops.GitError) as e:
        out["project"]["problem"] = str(e)
    out["agents"] = [{"name": a.name, "description": a.description, "model": a.model, "effort": a.effort,
                      "permission_mode": a.permission_mode} for a in repo.list_agents(found.id)]
    deps = repo.all_deps()
    out["tasks"] = [{"id": t.id, "title": t.title, "status": t.status, "target_branch": t.target_branch,
                     "depends_on": deps.get(t.id, [])}
                    for t in repo.list_tasks(found.id) if t.status != TaskStatus.DONE]
    return out


def _check_batch_stages(repo, cards: list[dict], edges: dict[int, list[int]], parent_id: int | None) -> None:
    """Stages of a batch: in range, under a parent, and not in a ring with the links of the batch or of the board.

    The new cards are checked as virtual ones (negative ids) next to the live board, the same way a single card is."""
    staged = [c for c in cards if c["stage"] is not None]
    if not staged:
        return
    for card in staged:
        if not 1 <= card["stage"] <= MAX_STAGE:
            raise HTTPException(400, f"card {card['title']!r}, stage: expected a number from 1 to {MAX_STAGE}")
    if parent_id is None:
        raise HTTPException(400, "stage: only a subtask has a stage, and these cards have no parent. "
                                 "Name a parent, or run this from a card")
    virtual = {i: -(i + 1) for i in range(len(cards))}
    nodes = [(t.id, t.parent_task_id, t.stage) for t in repo.list_tasks()]
    nodes += [(virtual[i], parent_id, c["stage"]) for i, c in enumerate(cards)]
    explicit = dict(repo.all_deps())
    for i, card in enumerate(cards):
        explicit[virtual[i]] = [*card["existing"], *(virtual[j] for j in edges[i])]
    if any(stages.closes_ring(virtual[i], nodes, explicit) for i in range(len(cards))):
        raise HTTPException(400, "stage: the stages and the depends_on of this batch make cards wait for each other in a ring, "
                                 "none would ever start")
